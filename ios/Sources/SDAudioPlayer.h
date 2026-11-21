#import <Foundation/Foundation.h>

// Plays the raw 16-bit PCM sound coming from Android, with a small buffer to keep the delay low.
@interface SDAudioPlayer : NSObject
- (void)startWithSampleRate:(double)sampleRate channels:(uint32_t)channels;
- (void)enqueue:(NSData *)pcm;  // any thread
- (void)stop;
@property (nonatomic, readonly) BOOL running;
@end
