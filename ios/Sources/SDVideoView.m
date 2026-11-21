#import "SDVideoView.h"
#import <AVFoundation/AVFoundation.h>
#import <CoreMedia/CoreMedia.h>
#import <QuartzCore/QuartzCore.h>

typedef void (^SDNalBlock)(const uint8_t *nal, size_t length);

// Calls block for every NAL unit in an Annex-B byte stream.
static void SDForEachNal(const uint8_t *p, size_t n, SDNalBlock block) {
    size_t i = 0;
    size_t start = SIZE_MAX;
    while (i + 3 <= n) {
        if (p[i] == 0 && p[i + 1] == 0 && p[i + 2] == 1) {
            if (start != SIZE_MAX) {
                size_t end = i;
                while (end > start && p[end - 1] == 0) end--;
                if (end > start) block(p + start, end - start);
            }
            i += 3;
            start = i;
        } else {
            i++;
        }
    }
    if (start != SIZE_MAX && start < n) block(p + start, n - start);
}

@implementation SDVideoView {
    CMVideoFormatDescriptionRef _format;
    BOOL _waitForKeyFrame;
    BOOL _shownFrame;
    CFTimeInterval _lastKeyRequest;
}

+ (Class)layerClass {
    return [AVSampleBufferDisplayLayer class];
}

- (AVSampleBufferDisplayLayer *)displayLayer {
    return (AVSampleBufferDisplayLayer *)self.layer;
}

- (instancetype)initWithFrame:(CGRect)frame {
    if ((self = [super initWithFrame:frame])) {
        self.backgroundColor = [UIColor blackColor];
        self.displayLayer.videoGravity = AVLayerVideoGravityResizeAspect;
        _waitForKeyFrame = YES;
    }
    return self;
}

- (void)dealloc {
    if (_format) CFRelease(_format);
}

- (void)resetAll {
    @synchronized(self) {
        if (_format) CFRelease(_format);
        _format = NULL;
        _waitForKeyFrame = YES;
        _shownFrame = NO;
    }
    [self.displayLayer flushAndRemoveImage];
}

- (CGRect)videoRect {
    CGSize size = self.videoSize;
    if (size.width <= 0 || size.height <= 0) {
        @synchronized(self) {
            if (_format) {
                CMVideoDimensions d = CMVideoFormatDescriptionGetDimensions(_format);
                size = CGSizeMake(d.width, d.height);
            }
        }
    }
    if (size.width <= 0 || size.height <= 0) return CGRectZero;
    return AVMakeRectWithAspectRatioInsideRect(size, self.bounds);
}

- (void)requestKeyFrame {
    dispatch_async(dispatch_get_main_queue(), ^{
        CFTimeInterval now = CACurrentMediaTime();
        if (now - self->_lastKeyRequest < 1.0) return;
        self->_lastKeyRequest = now;
        if (self.onNeedKeyFrame) self.onNeedKeyFrame();
    });
}

- (void)updateFormatWithSps:(NSData *)sps pps:(NSData *)pps {
    const uint8_t *sets[2] = {(const uint8_t *)sps.bytes, (const uint8_t *)pps.bytes};
    size_t sizes[2] = {sps.length, pps.length};
    CMVideoFormatDescriptionRef format = NULL;
    OSStatus status = CMVideoFormatDescriptionCreateFromH264ParameterSets(kCFAllocatorDefault, 2, sets, sizes, 4, &format);
    if (status == noErr && format) {
        if (_format) CFRelease(_format);
        _format = format;
    }
}

- (CMSampleBufferRef)newSampleWithAvcc:(NSData *)avcc {
    CMBlockBufferRef block = NULL;
    OSStatus status = CMBlockBufferCreateWithMemoryBlock(kCFAllocatorDefault, NULL, avcc.length, kCFAllocatorDefault, NULL, 0, avcc.length,
                                                         kCMBlockBufferAssureMemoryNowFlag, &block);
    if (status != kCMBlockBufferNoErr || !block) return NULL;
    CMBlockBufferReplaceDataBytes(avcc.bytes, block, 0, avcc.length);
    CMSampleBufferRef sample = NULL;
    size_t sampleSize = avcc.length;
    status = CMSampleBufferCreateReady(kCFAllocatorDefault, block, _format, 1, 0, NULL, 1, &sampleSize, &sample);
    CFRelease(block);
    if (status != noErr || !sample) return NULL;
    CFArrayRef attachments = CMSampleBufferGetSampleAttachmentsArray(sample, YES);
    if (attachments && CFArrayGetCount(attachments) > 0) {
        CFMutableDictionaryRef dict = (CFMutableDictionaryRef)CFArrayGetValueAtIndex(attachments, 0);
        CFDictionarySetValue(dict, kCMSampleAttachmentKey_DisplayImmediately, kCFBooleanTrue);
    }
    return sample;
}

- (void)handlePacket:(NSData *)payload {
    if (payload.length < 2) return;
    const uint8_t *bytes = (const uint8_t *)payload.bytes;
    BOOL isKeyFrame = (bytes[0] & 2) != 0;

    NSMutableData *avcc = [NSMutableData dataWithCapacity:payload.length + 16];
    __block NSData *sps = nil;
    __block NSData *pps = nil;
    __block BOOL hasIdr = NO;
    SDForEachNal(bytes + 1, payload.length - 1, ^(const uint8_t *nal, size_t length) {
        uint8_t type = nal[0] & 0x1f;
        if (type == 7) {
            sps = [NSData dataWithBytes:nal length:length];
        } else if (type == 8) {
            pps = [NSData dataWithBytes:nal length:length];
        } else if (type != 9) {  // skip access unit delimiters
            if (type == 5) hasIdr = YES;
            uint32_t bigEndianLength = CFSwapInt32HostToBig((uint32_t)length);
            [avcc appendBytes:&bigEndianLength length:4];
            [avcc appendBytes:nal length:length];
        }
    });

    CMSampleBufferRef sample = NULL;
    BOOL needKey = NO;
    @synchronized(self) {
        if (sps && pps) [self updateFormatWithSps:sps pps:pps];
        if (avcc.length == 0) return;
        if (!_format) {
            needKey = YES;
        } else if (_waitForKeyFrame && !(isKeyFrame || hasIdr)) {
            needKey = YES;
        } else {
            _waitForKeyFrame = NO;
            sample = [self newSampleWithAvcc:avcc];
        }
    }
    if (needKey) {
        [self requestKeyFrame];
        return;
    }
    if (!sample) return;

    dispatch_async(dispatch_get_main_queue(), ^{
        AVSampleBufferDisplayLayer *layer = self.displayLayer;
        if (layer.status == AVQueuedSampleBufferRenderingStatusFailed) {
            [layer flush];
            @synchronized(self) {
                self->_waitForKeyFrame = YES;
            }
            [self requestKeyFrame];
        } else {
            [layer enqueueSampleBuffer:sample];
            if (!self->_shownFrame) {
                self->_shownFrame = YES;
                if (self.onFirstFrame) self.onFirstFrame();
            }
        }
        CFRelease(sample);
    });
}

@end
