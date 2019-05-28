// tslint:disable-next-line:max-line-length
import {
    DataStore, Dialog, GameModuleInterface, GameModuleLaunchArgs,
    GResLoader, LEnv, LobbyModuleInterface, Logger, MsgQueue,
    MsgType, RoomInfo, UserInfo, WS
} from "../lobby/lcore/LCoreExports";
import { proto } from "./proto/protoGame";
import { Room } from "./Room";

const mc = proto.mahjong.MessageCode;
const priorityMap: { [key: number]: number } = {
    [mc.OPDisbandRequest]: 1, [mc.OPDisbandNotify]: 1, [mc.OPDisbandAnswer]: 1
};

/**
 * 子游戏入口
 */
export class GameModule extends cc.Component implements GameModuleInterface {
    public eventTarget: cc.EventTarget;

    public loader: GResLoader;

    private view: fgui.GComponent;

    // private url: string;
    // private myUser: UserInfo;
    private ws: WS;
    private mq: MsgQueue;
    private connectErrorCount: number;
    private retry: boolean = false;
    private forceExit: boolean = false;
    private room: Room;
    private lm: LobbyModuleInterface;

    public get resLoader(): GResLoader {
        return this.loader;
    }

    public async launch(args: GameModuleLaunchArgs): Promise<void> {
        // 尝试进入房间
        this.lm = args.lm;
        this.loader = args.loader;

        // 加载游戏界面
        this.loader.fguiAddPackage("lobby/fui_lobby_mahjong/lobby_mahjong");
        this.loader.fguiAddPackage("gameb/dafeng");

        const view = fgui.UIPackage.createObject("dafeng", "desk").asCom;
        fgui.GRoot.inst.addChild(view);
        this.view = view;

        await this.tryEnterRoom(args.uuid, args.userInfo, args.roomInfo);
    }

    public quit(): void {
        if (this.mq !== undefined && this.mq !== null) {
            this.mq.pushQuit();
        }
    }

    protected onLoad(): void {
        this.eventTarget = new cc.EventTarget();
    }

    protected start(): void {
        // nothing to do
    }

    protected onDestroy(): void {
        this.eventTarget.emit("destroy");

        fgui.GRoot.inst.removeChild(this.view);
        this.view.dispose();

        this.lm.returnFromGame();
    }

    private async tryEnterRoom(
        serverUUID: string,
        myUser: UserInfo,
        roomInfo: RoomInfo): Promise<void> {

        // 测试用
        const host = LEnv.gameHost;
        const tk = DataStore.getString("token", "");
        let url;
        const rID = roomInfo.roomID;
        const uID = myUser.userID;

        const path = LEnv.cfmt(LEnv.gameWebsocketPlay, serverUUID);
        url = `${host}${path}?userID=${uID}&roomID=${rID}&tk=${tk}&web=1`;

        Logger.debug("tryEnterRoom, url:", url);

        // 保存一下，以便重连时使用
        // this.url = url;
        // this.myUser = myUser;
        this.ws = null;
        this.room = null;
        this.connectErrorCount = 0;

        let loop = true;
        while (loop) {
            await this.doEnterRoom(url, myUser, roomInfo);
            Logger.debug("doEnterRoom return, retry:", this.retry, ", forceExit:", this.forceExit);

            this.connectErrorCount++;
            if (this.ws !== null) {
                const ws = this.ws;
                this.ws = null;
                ws.ww.close();
            }

            if (!this.retry || this.forceExit) {
                loop = false;
            }
        }

        if (this.room !== null) {
            this.room = null;
        }

        // 退出到大厅
        this.backToLobby();
    }

    private backToLobby(): void {
        this.destroy();
    }

    private async doEnterRoom(
        url: string,
        myUser: UserInfo,
        roomInfo: RoomInfo): Promise<void> {
        //
        Logger.debug("doEnterRoom enter---");
        // 每次进入本函数时都重置retry为false
        // 如果发生断线重连且用户选择了重连那么后面的代码
        // 会置retry为true
        this.retry = false;

        // this.room可能不为null，因为如果断线重入，room以及roomview就可能已经加载
        if (this.room === null) {
            this.createRoom(myUser, roomInfo);
        }

        // 显示登录房间等待进度框
        // 显示于界面的等待信息
        const showProgressTips = "正在进入房间";

        // host 结构
        const host = {
            comp: this,
            destroyListener: this.eventTarget,
            startPing: true,
            pingFrequency: 3, // 3秒
            pingPacketProvider: (pingData: ByteBuffer) => {
                const msg = {
                    Ops: proto.mahjong.MessageCode.OPPing,
                    Data: pingData
                };

                return proto.mahjong.GameMessage.encode(msg).toArrayBuffer();
            }
        };
        // ping pong 结构
        const pp = {
            pingCmd: mc.OPPing,
            pongCmd: mc.OPPong,
            decode: proto.mahjong.GameMessage.decode,
            encode: proto.mahjong.GameMessage.encode
        };

        const mq = new MsgQueue(priorityMap);
        const ws = new WS(url, mq, host, pp);
        this.mq = mq;
        this.ws = ws;

        const rt = await this.waitConnect(showProgressTips);
        let enterRoomReplyMsg;
        let enterRoomResult;
        if (rt !== 0) {
            this.retry = true;
            if (this.connectErrorCount > 0) {
                await this.showRetryMsgBox();
            }

            return;
        } else {
            Logger.debug("waitWebsocketMessage wait room reply");
            enterRoomReplyMsg = await this.waitWebsocketMessage(showProgressTips);
        }

        if (enterRoomReplyMsg === null) {
            // 连接超时提示和处理（用户选择是否重连，重连的话下一帧重新执行tryEnterRoom）
            Logger.debug(" waitWebsocketMessage return nil");
            this.retry = true;
            if (this.connectErrorCount > 0) {
                await this.showRetryMsgBox();
            }

            return;
        }

        enterRoomResult = proto.mahjong.MsgEnterRoomResult.decode(enterRoomReplyMsg.Data);
        Logger.debug(" server reply enter room status:", enterRoomResult.status);
        if (enterRoomResult.status !== 0) {
            // 进入房间错误提示
            Logger.debug(" server return enter room ~= 0");
            await this.showEnterRoomError(enterRoomResult.status);

            return;
        }

        await this.pumpMsg();
        Logger.debug("doEnterRoom leave---");
    }

    private createRoom(
        myUser: UserInfo,
        roomInfo: RoomInfo): void {
        //
        this.room = new Room(myUser, roomInfo, this);
    }

    private async waitConnect(showProgressTips: string): Promise<number> {
        Logger.debug("Game.waitConnect, ", showProgressTips);

        const msg = await this.mq.waitMsg();

        Logger.debug("Game.waitConnect, mq.waitMsg return:", msg);

        if (msg.mt === MsgType.wsOpen) {
            return 0;
        }

        return -1;
    }

    private async showRetryMsgBox(msg?: string): Promise<void> {
        const msgShow = msg !== undefined ? msg : "连接游戏服务器失败，是否重连？";
        const yesno = await Dialog.coShowDialog(msgShow, true, true);

        this.retry = yesno;
    }

    private async showEnterRoomError(code: number): Promise<void> {
        const msg = this.getEnterRoomErrorCode(code);
        Logger.warn("enter room failed, server return error：", msg);
        await Dialog.coShowDialog(msg, true, false);
    }

    private getEnterRoomErrorCode(code: number): string {
        const mahjong = proto.mahjong.EnterRoomStatus;
        const enterRoomErrorMap: { [key: number]: string } = {
            [mahjong.RoomNotExist]: "房间不存在",
            [mahjong.RoomIsFulled]: "你输入的房间已满，无法加入",
            [mahjong.RoomPlaying]: "房间正在游戏中",
            [mahjong.InAnotherRoom]: "您已经再另一个房间",
            [mahjong.MonkeyRoomUserIDNotMatch]: "测试房间userID不匹配",
            [mahjong.MonkeyRoomUserLoginSeqNotMatch]: "测试房间进入顺序不匹配",
            [mahjong.AppModuleNeedUpgrade]: "您的APP版本过老，请升级到最新版本",
            [mahjong.InRoomBlackList]: "您被房主踢出房间，10分钟内无法再次加入此房间",
            [mahjong.TakeoffDiamondFailedNotEnough]: "您的钻石不足，不能进入房间，请充值",
            [mahjong.TakeoffDiamondFailedIO]: "抱歉，系统扣除钻石失败，不能进入房间",
            [mahjong.RoomInApplicateDisband]: "房间正在解散"
        };

        return enterRoomErrorMap[code] !== undefined ? enterRoomErrorMap[code] : "未知错误";
    }

    private async waitWebsocketMessage(showProgressTips: string): Promise<proto.mahjong.GameMessage> {
        Logger.debug("SG:waitWebsocketMessage, ", showProgressTips);
        const msg = await this.mq.waitMsg();
        if (msg.mt === MsgType.wsData) {
            return <proto.mahjong.GameMessage>msg.data;
        } else {
            Logger.error("expected normal websocket msg, but got:", msg);
        }

        return null;
    }

    private async pumpMsg(): Promise<void> {
        let loop = true;
        while (loop) {
            const mq = this.mq;
            const msg = await mq.waitMsg();
            if (msg.mt === MsgType.quit) {
                break;
            }

            if (msg.mt === MsgType.wsData) {
                this.room.dispatchWebsocketMsg(<proto.mahjong.GameMessage>msg.data);
            } else if (msg.mt === MsgType.wsClosed || msg.mt === MsgType.wsError) {
                Logger.debug(" websocket connection has broken");
                if (this.room.isDestroy) {
                    // 用户主动离开房间，不再做重入
                    Logger.debug(" room has been destroy");
                    break;
                }

                // 网络连接断开，重新登入
                await this.showRetryMsgBox("与游戏服务器连接断开，是否重连？");
                this.retry = true;

                if (this.connectErrorCount > 2) {
                    await this.showRetryMsgBox();
                }

                loop = false;
            }
        }
    }
}