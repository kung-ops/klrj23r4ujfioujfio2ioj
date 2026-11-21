// Sandroid wire protocol (TCP port 8080, not HTTP).
// Every message: [u8 type][u32 big-endian length][payload]. See server/lib/protocol.js.

#import <Foundation/Foundation.h>

#define SD_DEFAULT_PORT 8080
#define SD_PROTOCOL_VERSION 1

typedef NS_ENUM(uint8_t, SDClientMessage) {
    SDMsgHello = 0x01,
    SDMsgPing = 0x02,
    SDMsgTouch = 0x10,
    SDMsgKey = 0x11,
    SDMsgText = 0x12,
    SDMsgNav = 0x13,
    SDMsgClipboard = 0x15,
    SDMsgUploadBegin = 0x20,
    SDMsgUploadChunk = 0x21,
    SDMsgUploadEnd = 0x22,
    SDMsgListFiles = 0x23,
    SDMsgDownload = 0x24,
    SDMsgCameraFrame = 0x30,
    SDMsgCameraStop = 0x31,
};

typedef NS_ENUM(uint8_t, SDServerMessage) {
    SDMsgError = 0x80,
    SDMsgWelcome = 0x81,
    SDMsgStatus = 0x82,
    SDMsgPong = 0x83,
    SDMsgNotice = 0x84,
    SDMsgVideoSize = 0x90,
    SDMsgVideoPacket = 0x91,
    SDMsgAudioFormat = 0x92,
    SDMsgAudioPacket = 0x93,
    SDMsgClipboardFromAndroid = 0x94,
    SDMsgFileList = 0xA0,
    SDMsgDownloadBegin = 0xA1,
    SDMsgDownloadChunk = 0xA2,
    SDMsgDownloadEnd = 0xA3,
    SDMsgUploadDone = 0xA4,
};

typedef NS_ENUM(uint8_t, SDNav) {
    SDNavBack = 1,
    SDNavHome = 2,
    SDNavRecents = 3,
    SDNavPower = 4,
    SDNavVolumeUp = 5,
    SDNavVolumeDown = 6,
    SDNavNotifications = 7,
    SDNavRotate = 8,
    SDNavResetVideo = 9,
    SDNavRestartAndroid = 10,
};

typedef NS_ENUM(uint8_t, SDTouchAction) {
    SDTouchDown = 0,
    SDTouchUp = 1,
    SDTouchMove = 2,
    SDTouchCancel = 3,
};

// Android key codes we send.
enum {
    SDKeyTab = 61,
    SDKeyEnter = 66,
    SDKeyDel = 67,
    SDKeyEscape = 111,
    SDKeyDpadUp = 19,
    SDKeyDpadDown = 20,
    SDKeyDpadLeft = 21,
    SDKeyDpadRight = 22,
};
