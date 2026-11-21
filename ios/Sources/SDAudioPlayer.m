#import "SDAudioPlayer.h"
#import <AudioToolbox/AudioToolbox.h>
#import <AVFoundation/AVFoundation.h>
#include <os/lock.h>

#define SD_AUDIO_BUFFERS 3
#define SD_AUDIO_BUFFER_BYTES 7680  // 40 ms of 48 kHz stereo 16-bit

@interface SDAudioPlayer ()
- (void)fillBuffer:(AudioQueueBufferRef)buffer;
@end

static void SDAudioOutputCallback(void *userData, AudioQueueRef queue, AudioQueueBufferRef buffer) {
    SDAudioPlayer *player = (__bridge SDAudioPlayer *)userData;
    [player fillBuffer:buffer];
    AudioQueueEnqueueBuffer(queue, buffer, 0, NULL);
}

@implementation SDAudioPlayer {
    AudioQueueRef _queue;
    AudioQueueBufferRef _buffers[SD_AUDIO_BUFFERS];
    NSMutableData *_ring;
    os_unfair_lock _lock;
    size_t _bytesPerSecond;
    size_t _bytesPerFrame;
}

- (instancetype)init {
    if ((self = [super init])) {
        _ring = [NSMutableData data];
        _lock = OS_UNFAIR_LOCK_INIT;
    }
    return self;
}

- (void)dealloc {
    [self stop];
}

- (void)fillBuffer:(AudioQueueBufferRef)buffer {
    UInt32 capacity = buffer->mAudioDataBytesCapacity;
    uint8_t *dst = (uint8_t *)buffer->mAudioData;
    os_unfair_lock_lock(&_lock);
    size_t n = MIN(_ring.length, (size_t)capacity);
    if (_bytesPerFrame) n -= n % _bytesPerFrame;
    if (n > 0) {
        memcpy(dst, _ring.bytes, n);
        [_ring replaceBytesInRange:NSMakeRange(0, n) withBytes:NULL length:0];
    }
    os_unfair_lock_unlock(&_lock);
    if (n < capacity) memset(dst + n, 0, capacity - n);  // silence while waiting for data
    buffer->mAudioDataByteSize = capacity;
}

- (void)startWithSampleRate:(double)sampleRate channels:(uint32_t)channels {
    [self stop];
    // Looked up at run time so the app does not link AVFAudio.framework directly
    // (newer SDKs moved AVAudioSession there; on iOS 12 it lives inside AVFoundation).
    Class sessionClass = NSClassFromString(@"AVAudioSession");
    AVAudioSession *session = [sessionClass sharedInstance];
    [session setCategory:@"AVAudioSessionCategoryPlayback" error:nil];
    [session setActive:YES error:nil];

    AudioStreamBasicDescription format;
    memset(&format, 0, sizeof format);
    format.mSampleRate = sampleRate;
    format.mFormatID = kAudioFormatLinearPCM;
    format.mFormatFlags = kLinearPCMFormatFlagIsSignedInteger | kLinearPCMFormatFlagIsPacked;
    format.mChannelsPerFrame = channels;
    format.mBitsPerChannel = 16;
    format.mBytesPerFrame = 2 * channels;
    format.mFramesPerPacket = 1;
    format.mBytesPerPacket = format.mBytesPerFrame;
    _bytesPerFrame = format.mBytesPerFrame;
    _bytesPerSecond = (size_t)(sampleRate * format.mBytesPerFrame);

    AudioQueueRef queue = NULL;
    if (AudioQueueNewOutput(&format, SDAudioOutputCallback, (__bridge void *)self, NULL, NULL, 0, &queue) != noErr) return;
    _queue = queue;
    for (int i = 0; i < SD_AUDIO_BUFFERS; i++) {
        if (AudioQueueAllocateBuffer(queue, SD_AUDIO_BUFFER_BYTES, &_buffers[i]) == noErr) {
            [self fillBuffer:_buffers[i]];
            AudioQueueEnqueueBuffer(queue, _buffers[i], 0, NULL);
        }
    }
    AudioQueueStart(queue, NULL);
    _running = YES;
}

- (void)enqueue:(NSData *)pcm {
    if (!_running || pcm.length == 0) return;
    os_unfair_lock_lock(&_lock);
    [_ring appendData:pcm];
    size_t limit = _bytesPerSecond / 4;  // more than 250 ms waiting: drop the oldest sound
    if (_ring.length > limit) {
        size_t keep = _bytesPerSecond / 10;
        size_t drop = _ring.length - keep;
        if (_bytesPerFrame) drop -= drop % _bytesPerFrame;
        [_ring replaceBytesInRange:NSMakeRange(0, drop) withBytes:NULL length:0];
    }
    os_unfair_lock_unlock(&_lock);
}

- (void)stop {
    _running = NO;
    if (_queue) {
        AudioQueueStop(_queue, true);
        AudioQueueDispose(_queue, true);
        _queue = NULL;
    }
    os_unfair_lock_lock(&_lock);
    [_ring setLength:0];
    os_unfair_lock_unlock(&_lock);
}

@end
