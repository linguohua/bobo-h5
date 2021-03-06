import { Dialog, Logger } from "../../lobby/lcore/LCoreExports";
import { proto } from "../proto/protoGameA";
import { RoomInterfaceA } from "../RoomInterfaceA";

/**
 * 响应服务器更新解散事件，例如有人拒绝，有人同意等
 */
export namespace HandlerMsgDisbandNotifyA {
    export const onMsg = async (msgData: ByteBuffer, room: RoomInterfaceA): Promise<void> => {
        Logger.debug("HandlerMsgDisbandNotify");
        const msgDisbandNotify = proto.pokerface.MsgDisbandNotify.decode(msgData);
        // const mjproto2 = proto.mahjong.DisbandState;
        // msgDisbandNotify:ParseFromString(msgData)
        const state = msgDisbandNotify.disbandState;
        if (state === proto.pokerface.DisbandState.ErrorDuplicateAcquire) {
            Dialog.prompt("已经有人申请了解散房间");

            return;
        } else if (state === proto.pokerface.DisbandState.ErrorNeedOwnerWhenGameNotStart) {
            Dialog.prompt("牌局未开始，只有房主可以解散房间");

            return;
        }

        //保存到room到，以便重复点击申请解散按钮进而显示
        room.updateDisbandVoteView(msgDisbandNotify);
    };
}
