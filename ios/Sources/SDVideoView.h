#import <UIKit/UIKit.h>

// Shows the Android screen: H.264 decoded by the iPhone's hardware through AVSampleBufferDisplayLayer.
@interface SDVideoView : UIView

@property (nonatomic) CGSize videoSize;                     // main thread
@property (nonatomic, copy) void (^onFirstFrame)(void);     // main thread
@property (nonatomic, copy) void (^onNeedKeyFrame)(void);   // main thread

// payload = [u8 flags (1 config, 2 key frame)][Annex-B H.264]. Any thread.
- (void)handlePacket:(NSData *)payload;

// Forget everything (new connection). Main thread.
- (void)resetAll;

// Where the picture is drawn inside the view (for mapping touches).
- (CGRect)videoRect;

@end
