#import <Foundation/Foundation.h>
#import <AVFoundation/AVFoundation.h>

// Captures the iPhone camera at 640x480 and hands out JPEG frames (about 12 per second).
@interface SDCamera : NSObject
@property (nonatomic, copy) void (^onFrame)(NSData *jpeg);  // camera thread
@property (nonatomic, readonly) AVCaptureSession *session;
@property (nonatomic, readonly) BOOL front;
@property (nonatomic, readonly) BOOL running;
- (void)startWithFront:(BOOL)front completion:(void (^)(NSString *error))completion;  // completion on main
- (void)stop;
@end
