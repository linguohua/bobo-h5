import { Logger } from "../../lobby/lcore/LCoreExports";
import { proto } from "../proto/protoGame";
import { RoomInterface } from "../RoomInterface";

/**
 * 响应服务器更新解散事件，例如有人拒绝，有人同意等
 */
export namespace HandlerMsgDisbandNotify {
    export const onMsg = async (msgData: ByteBuffer, room: RoomInterface): Promise<void> => {
        Logger.debug("HandlerMsgDisbandNotify");
        const msgDisbandNotify = proto.mahjong.MsgDisbandNotify.decode(msgData);
        // const mjproto2 = proto.mahjong.DisbandState;
        // msgDisbandNotify:ParseFromString(msgData)

        //保存到room到，以便重复点击申请解散按钮进而显示
        room.updateDisbandVoteView(msgDisbandNotify);
    };
}
