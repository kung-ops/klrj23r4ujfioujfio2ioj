#import "SDCamera.h"
#import <CoreImage/CoreImage.h>
#import <ImageIO/ImageIO.h>
#import <QuartzCore/QuartzCore.h>

@interface SDCamera () <AVCaptureVideoDataOutputSampleBufferDelegate>
@end

@implementation SDCamera {
    dispatch_queue_t _queue;
    CIContext *_context;
    CGColorSpaceRef _colorSpace;
    CFTimeInterval _lastFrame;
}

- (instancetype)init {
    if ((self = [super init])) {
        _queue = dispatch_queue_create("sandroid.camera", DISPATCH_QUEUE_SERIAL);
        _context = [CIContext contextWithOptions:nil];
        _colorSpace = CGColorSpaceCreateDeviceRGB();
    }
    return self;
}

- (void)dealloc {
    [self stop];
    if (_colorSpace) CGColorSpaceRelease(_colorSpace);
}

- (BOOL)running {
    return _session != nil;
}

- (void)startWithFront:(BOOL)front completion:(void (^)(NSString *))completion {
    [AVCaptureDevice requestAccessForMediaType:AVMediaTypeVideo
                             completionHandler:^(BOOL granted) {
                                 dispatch_async(dispatch_get_main_queue(), ^{
                                     if (!granted) {
                                         completion(@"Camera access is off. Turn it on in Settings > Privacy > Camera > Sandroid.");
                                         return;
                                     }
                                     completion([self configureFront:front]);
                                 });
                             }];
}

- (NSString *)configureFront:(BOOL)front {
    [self stop];
    AVCaptureDevicePosition position = front ? AVCaptureDevicePositionFront : AVCaptureDevicePositionBack;
    AVCaptureDevice *device = [AVCaptureDevice defaultDeviceWithDeviceType:AVCaptureDeviceTypeBuiltInWideAngleCamera
                                                                 mediaType:AVMediaTypeVideo
                                                                  position:position];
    if (!device) return @"This iPhone has no such camera.";
    NSError *error = nil;
    AVCaptureDeviceInput *input = [AVCaptureDeviceInput deviceInputWithDevice:device error:&error];
    if (!input) return error.localizedDescription ?: @"Could not open the camera.";

    AVCaptureSession *session = [AVCaptureSession new];
    if ([session canSetSessionPreset:AVCaptureSessionPreset640x480]) session.sessionPreset = AVCaptureSessionPreset640x480;
    if (![session canAddInput:input]) return @"Could not use the camera.";
    [session addInput:input];

    AVCaptureVideoDataOutput *output = [AVCaptureVideoDataOutput new];
    output.videoSettings = @{(__bridge id)kCVPixelBufferPixelFormatTypeKey : @(kCVPixelFormatType_32BGRA)};
    output.alwaysDiscardsLateVideoFrames = YES;
    [output setSampleBufferDelegate:self queue:_queue];
    if (![session canAddOutput:output]) return @"Could not use the camera.";
    [session addOutput:output];

    _front = front;
    _session = session;
    dispatch_async(_queue, ^{
        [session startRunning];
    });
    return nil;
}

- (void)captureOutput:(AVCaptureOutput *)output didOutputSampleBuffer:(CMSampleBufferRef)sampleBuffer fromConnection:(AVCaptureConnection *)connection {
    CFTimeInterval now = CACurrentMediaTime();
    if (now - _lastFrame < 1.0 / 12.0) return;
    _lastFrame = now;
    CVPixelBufferRef pixels = CMSampleBufferGetImageBuffer(sampleBuffer);
    if (!pixels) return;
    CIImage *image = [CIImage imageWithCVPixelBuffer:pixels];
    NSDictionary *options = @{(__bridge id)kCGImageDestinationLossyCompressionQuality : @(0.6)};
    NSData *jpeg = [_context JPEGRepresentationOfImage:image colorSpace:_colorSpace options:options];
    void (^handler)(NSData *) = self.onFrame;
    if (jpeg && handler) handler(jpeg);
}

- (void)stop {
    AVCaptureSession *session = _session;
    _session = nil;
    if (session) {
        dispatch_async(_queue, ^{
            [session stopRunning];
        });
    }
}

@end
