#import "SDStreamViewController.h"
#import "AppDelegate.h"
#import "SDAudioPlayer.h"
#import "SDCamera.h"
#import "SDConnection.h"
#import "SDDiscovery.h"
#import "SDFileBrowserViewController.h"
#import "SDKeyboardView.h"
#import "SDProtocol.h"
#import "SDVideoView.h"

#import <AVFoundation/AVFoundation.h>
#import <MobileCoreServices/MobileCoreServices.h>
#include <sys/sysctl.h>

static NSString *SDDeviceModel(void) {
    size_t size = 0;
    sysctlbyname("hw.machine", NULL, &size, NULL, 0);
    if (size == 0) return @"iPhone";
    char *machine = malloc(size);
    sysctlbyname("hw.machine", machine, &size, NULL, 0);
    NSString *model = [NSString stringWithUTF8String:machine];
    free(machine);
    return model ?: @"iPhone";
}

static NSDictionary *SDJSON(NSData *data) {
    if (data.length == 0) return @{};
    id obj = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
    return [obj isKindOfClass:[NSDictionary class]] ? obj : @{};
}

static NSString *SDString(id value) {
    return [value isKindOfClass:[NSString class]] ? value : nil;
}

@interface SDStreamViewController () <SDConnectionDelegate, UIDocumentPickerDelegate, UIImagePickerControllerDelegate, UINavigationControllerDelegate>
@property (atomic, strong) SDConnection *connection;
@end

@implementation SDStreamViewController {
    SDServer *_server;
    NSString *_pin;

    SDVideoView *_videoView;
    UIView *_overlay;
    UILabel *_statusLabel;
    UIActivityIndicatorView *_spinner;
    UIButton *_leaveButton;
    UIButton *_menuButton;
    UILabel *_toast;
    NSUInteger _toastGeneration;
    SDKeyboardView *_keyboard;

    SDAudioPlayer *_audio;
    SDCamera *_camera;
    UIView *_previewView;
    AVCaptureVideoPreviewLayer *_previewLayer;
    int _cameraInFlight;  // frames on their way, updated with __atomic builtins

    NSMutableDictionary<NSValue *, NSNumber *> *_touchIds;
    NSTimer *_pingTimer;

    BOOL _visible;
    BOOL _userClosed;
    BOOL _suspended;
    BOOL _fatal;
    BOOL _hasVideo;
    BOOL _uploading;
    NSDictionary *_lastStatus;
    BOOL _cameraAvailable;
    NSString *_cameraReason;
    __weak SDFileBrowserViewController *_browser;

    // Only touched on the connection thread.
    NSFileHandle *_downloadHandle;
    NSString *_downloadPath;
    NSString *_downloadName;
    long long _downloadSize;
    long long _downloadReceived;
    CFTimeInterval _downloadLastUpdate;
}

- (instancetype)initWithServer:(SDServer *)server pin:(NSString *)pin {
    if ((self = [super initWithNibName:nil bundle:nil])) {
        _server = server;
        _pin = [pin copy];
        _touchIds = [NSMutableDictionary dictionary];
        _audio = [SDAudioPlayer new];
        _camera = [SDCamera new];
        _cameraInFlight = 0;
    }
    return self;
}

#pragma mark - view

- (void)viewDidLoad {
    [super viewDidLoad];
    UIView *root = self.view;
    root.backgroundColor = [UIColor blackColor];
    root.multipleTouchEnabled = YES;

    _videoView = [[SDVideoView alloc] initWithFrame:root.bounds];
    _videoView.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
    _videoView.userInteractionEnabled = NO;
    [root addSubview:_videoView];
    __weak SDStreamViewController *weakSelf = self;
    _videoView.onFirstFrame = ^{
        [weakSelf firstFrame];
    };
    _videoView.onNeedKeyFrame = ^{
        [weakSelf sendNav:SDNavResetVideo];
    };

    _keyboard = [[SDKeyboardView alloc] initWithFrame:CGRectMake(0, 0, 1, 1)];
    _keyboard.onText = ^(NSString *text) {
        [weakSelf.connection send:SDMsgText payload:[text dataUsingEncoding:NSUTF8StringEncoding]];
    };
    _keyboard.onKey = ^(int code) {
        [weakSelf pressKey:code];
    };
    [root addSubview:_keyboard];

    _overlay = [[UIView alloc] initWithFrame:root.bounds];
    _overlay.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
    _overlay.backgroundColor = [UIColor colorWithWhite:0 alpha:0.8];
    [root addSubview:_overlay];

    _spinner = [[UIActivityIndicatorView alloc] initWithActivityIndicatorStyle:UIActivityIndicatorViewStyleWhiteLarge];
    _spinner.hidesWhenStopped = YES;
    [_overlay addSubview:_spinner];

    _statusLabel = [UILabel new];
    _statusLabel.textColor = [UIColor whiteColor];
    _statusLabel.font = [UIFont systemFontOfSize:17];
    _statusLabel.numberOfLines = 0;
    _statusLabel.textAlignment = NSTextAlignmentCenter;
    [_overlay addSubview:_statusLabel];

    _leaveButton = [UIButton buttonWithType:UIButtonTypeSystem];
    [_leaveButton setTitle:@"Back to servers" forState:UIControlStateNormal];
    _leaveButton.titleLabel.font = [UIFont systemFontOfSize:17];
    [_leaveButton addTarget:self action:@selector(leave) forControlEvents:UIControlEventTouchUpInside];
    [_overlay addSubview:_leaveButton];

    _previewView = [[UIView alloc] initWithFrame:CGRectMake(12, 0, 90, 120)];
    _previewView.backgroundColor = [UIColor darkGrayColor];
    _previewView.layer.cornerRadius = 8;
    _previewView.layer.borderColor = [UIColor whiteColor].CGColor;
    _previewView.layer.borderWidth = 1;
    _previewView.clipsToBounds = YES;
    _previewView.hidden = YES;
    [_previewView addGestureRecognizer:[[UITapGestureRecognizer alloc] initWithTarget:self action:@selector(switchCamera)]];
    [root addSubview:_previewView];

    _menuButton = [UIButton buttonWithType:UIButtonTypeCustom];
    _menuButton.frame = CGRectMake(root.bounds.size.width - 58, 28, 46, 46);
    _menuButton.backgroundColor = [UIColor colorWithWhite:0.1 alpha:0.45];
    _menuButton.layer.cornerRadius = 23;
    _menuButton.layer.borderColor = [UIColor colorWithWhite:1 alpha:0.35].CGColor;
    _menuButton.layer.borderWidth = 1;
    [_menuButton setTitle:@"☰" forState:UIControlStateNormal];
    _menuButton.titleLabel.font = [UIFont systemFontOfSize:22];
    [_menuButton setTitleColor:[UIColor colorWithWhite:1 alpha:0.9] forState:UIControlStateNormal];
    [_menuButton addTarget:self action:@selector(showMenu) forControlEvents:UIControlEventTouchUpInside];
    [_menuButton addGestureRecognizer:[[UIPanGestureRecognizer alloc] initWithTarget:self action:@selector(dragMenu:)]];
    [root addSubview:_menuButton];

    _toast = [UILabel new];
    _toast.textColor = [UIColor whiteColor];
    _toast.backgroundColor = [UIColor colorWithWhite:0.1 alpha:0.85];
    _toast.font = [UIFont systemFontOfSize:15];
    _toast.numberOfLines = 0;
    _toast.textAlignment = NSTextAlignmentCenter;
    _toast.layer.cornerRadius = 10;
    _toast.clipsToBounds = YES;
    _toast.alpha = 0;
    _toast.userInteractionEnabled = NO;
    [root addSubview:_toast];

    NSNotificationCenter *nc = [NSNotificationCenter defaultCenter];
    [nc addObserver:self selector:@selector(appDidEnterBackground) name:UIApplicationDidEnterBackgroundNotification object:nil];
    [nc addObserver:self selector:@selector(appWillEnterForeground) name:UIApplicationWillEnterForegroundNotification object:nil];
    [nc addObserver:self selector:@selector(openFileNotification:) name:SDOpenFileNotification object:nil];
}

- (void)viewDidLayoutSubviews {
    [super viewDidLayoutSubviews];
    CGRect b = self.view.bounds;
    CGFloat w = MIN(b.size.width - 40, 420);
    CGSize textSize = [_statusLabel sizeThatFits:CGSizeMake(w, CGFLOAT_MAX)];
    CGFloat midY = b.size.height / 2;
    _spinner.center = CGPointMake(b.size.width / 2, midY - textSize.height / 2 - 34);
    _statusLabel.frame = CGRectMake((b.size.width - w) / 2, midY - textSize.height / 2, w, textSize.height);
    _leaveButton.frame = CGRectMake((b.size.width - 220) / 2, b.size.height - 80, 220, 44);
    _previewView.frame = CGRectMake(12, b.size.height - 132, 90, 120);
    _previewLayer.frame = _previewView.bounds;
    CGRect m = _menuButton.frame;
    m.origin.x = MAX(6, MIN(m.origin.x, b.size.width - m.size.width - 6));
    m.origin.y = MAX(6, MIN(m.origin.y, b.size.height - m.size.height - 6));
    _menuButton.frame = m;
    [self layoutToast];
}

- (void)layoutToast {
    CGRect b = self.view.bounds;
    CGFloat maxW = MIN(b.size.width - 40, 440);
    CGSize s = [_toast sizeThatFits:CGSizeMake(maxW - 24, CGFLOAT_MAX)];
    _toast.frame = CGRectMake((b.size.width - (s.width + 24)) / 2, 24, s.width + 24, s.height + 16);
}

- (void)viewDidAppear:(BOOL)animated {
    [super viewDidAppear:animated];
    _visible = YES;
    [UIApplication sharedApplication].idleTimerDisabled = YES;
    [self connect];
}

- (void)viewWillDisappear:(BOOL)animated {
    [super viewWillDisappear:animated];
    if (self.presentedViewController) return;  // a picker or menu is on top; keep streaming
    _visible = NO;
    [UIApplication sharedApplication].idleTimerDisabled = NO;
}

- (BOOL)prefersStatusBarHidden {
    return YES;
}

- (BOOL)prefersHomeIndicatorAutoHidden {
    return YES;
}

- (UIRectEdge)preferredScreenEdgesDeferringSystemGestures {
    return UIRectEdgeAll;
}

- (UIInterfaceOrientationMask)supportedInterfaceOrientations {
    return UIInterfaceOrientationMaskAllButUpsideDown;
}

#pragma mark - status overlay and toasts

- (void)showStatus:(NSString *)text spinner:(BOOL)spinner {
    _statusLabel.text = text;
    if (spinner) [_spinner startAnimating];
    else [_spinner stopAnimating];
    _overlay.hidden = NO;
    [self.view setNeedsLayout];
}

- (void)hideStatus {
    _overlay.hidden = YES;
    [_spinner stopAnimating];
}

- (void)updateStatusOverlay {
    NSString *phase = SDString(_lastStatus[@"phase"]) ?: @"";
    NSString *message = SDString(_lastStatus[@"message"]) ?: @"";
    if (phase.length && ![phase isEqualToString:@"ready"] && _hasVideo) {
        _hasVideo = NO;
        [_videoView resetAll];
    }
    if ([phase isEqualToString:@"ready"]) {
        if (_hasVideo) [self hideStatus];
        else [self showStatus:@"Android is ready.\nWaiting for the screen…" spinner:YES];
        return;
    }
    if ([phase isEqualToString:@"error"]) {
        [self showStatus:[@"The server has a problem:\n\n" stringByAppendingString:message] spinner:NO];
        return;
    }
    NSMutableString *text = [NSMutableString string];
    if ([phase isEqualToString:@"installing"]) [text appendString:@"Setting up Android on the computer.\nThis happens only the first time.\n\n"];
    [text appendString:message];
    id progress = _lastStatus[@"progress"];
    if ([progress isKindOfClass:[NSNumber class]]) [text appendFormat:@"\n%d%%", (int)lround([progress doubleValue] * 100)];
    [self showStatus:text spinner:YES];
}

- (void)toast:(NSString *)text {
    if (text.length == 0) return;
    _toast.text = text;
    [self layoutToast];
    [self.view bringSubviewToFront:_toast];
    NSUInteger generation = ++_toastGeneration;
    [UIView animateWithDuration:0.2
                     animations:^{
                         self->_toast.alpha = 1;
                     }];
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(3.5 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
        if (self->_toastGeneration != generation) return;
        [UIView animateWithDuration:0.4
                         animations:^{
                             self->_toast.alpha = 0;
                         }];
    });
}

- (void)alert:(NSString *)title message:(NSString *)message then:(void (^)(void))then {
    UIAlertController *a = [UIAlertController alertControllerWithTitle:title message:message preferredStyle:UIAlertControllerStyleAlert];
    [a addAction:[UIAlertAction actionWithTitle:@"OK"
                                          style:UIAlertActionStyleDefault
                                        handler:^(UIAlertAction *action) {
                                            if (then) then();
                                        }]];
    UIViewController *top = self;
    while (top.presentedViewController) top = top.presentedViewController;
    [top presentViewController:a animated:YES completion:nil];
}

#pragma mark - connection

- (void)connect {
    if (self.connection || _userClosed || _suspended || _fatal) return;
    [_videoView resetAll];
    _hasVideo = NO;
    [self showStatus:[NSString stringWithFormat:@"Connecting to %@…\n%@", _server.name, _server.displayAddress] spinner:YES];
    SDConnection *c = [[SDConnection alloc] initWithHost:_server.host port:_server.port];
    c.delegate = self;
    self.connection = c;
    [c connect];
}

- (void)disconnect {
    [_pingTimer invalidate];
    _pingTimer = nil;
    SDConnection *c = self.connection;
    self.connection = nil;
    [c close];
    [_audio stop];
    [self stopCamera];
    [_touchIds removeAllObjects];
}

- (void)leave {
    _userClosed = YES;
    [self disconnect];
    [self dismissViewControllerAnimated:YES completion:nil];
}

- (void)appDidEnterBackground {
    if (!_visible) return;
    _suspended = YES;
    [self disconnect];
}

- (void)appWillEnterForeground {
    if (!_suspended) return;
    _suspended = NO;
    if (_visible) [self connect];
}

- (void)connectionDidConnect:(SDConnection *)connection {
    if (connection != self.connection) return;
    NSDictionary *hello = @{
        @"pin" : _pin ?: @"",
        @"client" : @"Sandroid iOS",
        @"version" : @(SD_PROTOCOL_VERSION),
        @"device" : SDDeviceModel(),
        @"ios" : [UIDevice currentDevice].systemVersion ?: @""
    };
    [connection sendJSON:SDMsgHello object:hello];
    [self showStatus:@"Connected.\nWaiting for Android…" spinner:YES];
    [_pingTimer invalidate];
    _pingTimer = [NSTimer scheduledTimerWithTimeInterval:5 target:self selector:@selector(ping) userInfo:nil repeats:YES];
}

- (void)ping {
    [self.connection send:SDMsgPing payload:nil];
}

- (void)connection:(SDConnection *)connection didCloseWithError:(NSString *)error {
    if (connection != self.connection) return;
    self.connection = nil;
    [_pingTimer invalidate];
    _pingTimer = nil;
    [_audio stop];
    [self stopCamera];
    [_touchIds removeAllObjects];
    if (_fatal || _userClosed || _suspended || !error) return;
    [self showStatus:[NSString stringWithFormat:@"%@\n\nTrying again…", error] spinner:YES];
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(2 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
        if (self->_visible && [UIApplication sharedApplication].applicationState != UIApplicationStateBackground) [self connect];
    });
}

// Connection thread.
- (void)connection:(SDConnection *)connection didReceiveMessage:(uint8_t)type payload:(NSData *)payload {
    if (connection != self.connection) return;
    switch (type) {
        case SDMsgVideoPacket:
            [_videoView handlePacket:payload];
            return;
        case SDMsgAudioPacket:
            [_audio enqueue:payload];
            return;
        case SDMsgDownloadBegin:
            [self downloadBegin:SDJSON(payload)];
            return;
        case SDMsgDownloadChunk:
            [self downloadChunk:payload];
            return;
        case SDMsgDownloadEnd:
            [self downloadEnd:SDJSON(payload)];
            return;
        default:
            break;
    }
    dispatch_async(dispatch_get_main_queue(), ^{
        if (connection != self.connection) return;
        [self handleMessage:type payload:payload];
    });
}

- (void)handleMessage:(uint8_t)type payload:(NSData *)payload {
    switch (type) {
        case SDMsgError: {
            NSDictionary *e = SDJSON(payload);
            NSString *code = SDString(e[@"code"]) ?: @"";
            _fatal = YES;
            [self disconnect];
            if ([code isEqualToString:@"bad_pin"] && self.onWrongPin) self.onWrongPin();
            NSString *title = [code isEqualToString:@"bad_pin"] ? @"Wrong PIN" : @"Disconnected";
            [self alert:title
                message:SDString(e[@"message"]) ?: @"The server closed the connection."
                   then:^{
                       [self leave];
                   }];
            break;
        }
        case SDMsgWelcome: {
            NSDictionary *w = SDJSON(payload);
            NSDictionary *camera = [w[@"camera"] isKindOfClass:[NSDictionary class]] ? w[@"camera"] : @{};
            _cameraAvailable = [camera[@"available"] boolValue];
            _cameraReason = SDString(camera[@"reason"]);
            NSString *name = SDString(w[@"name"]);
            if (name.length) _server.name = name;
            break;
        }
        case SDMsgStatus:
            _lastStatus = SDJSON(payload);
            [self updateStatusOverlay];
            break;
        case SDMsgVideoSize:
            if (payload.length >= 4) {
                const uint8_t *b = (const uint8_t *)payload.bytes;
                _videoView.videoSize = CGSizeMake((b[0] << 8) | b[1], (b[2] << 8) | b[3]);
            }
            break;
        case SDMsgAudioFormat: {
            NSDictionary *f = SDJSON(payload);
            if ([SDString(f[@"codec"]) isEqualToString:@"pcm_s16le"]) {
                double rate = [f[@"rate"] doubleValue] ?: 48000;
                uint32_t channels = (uint32_t)([f[@"channels"] intValue] ?: 2);
                [_audio startWithSampleRate:rate channels:channels];
            } else {
                [_audio stop];
            }
            break;
        }
        case SDMsgClipboardFromAndroid: {
            NSString *text = [[NSString alloc] initWithData:payload encoding:NSUTF8StringEncoding];
            if (text.length && ![[UIPasteboard generalPasteboard].string isEqualToString:text]) {
                [UIPasteboard generalPasteboard].string = text;
                [self toast:@"Copied from Android"];
            }
            break;
        }
        case SDMsgNotice:
            [self toast:SDString(SDJSON(payload)[@"message"])];
            break;
        case SDMsgFileList:
            [_browser showListing:SDJSON(payload)];
            break;
        case SDMsgUploadDone: {
            NSDictionary *r = SDJSON(payload);
            [self toast:SDString(r[@"message"]) ?: @"Done"];
            break;
        }
        default:
            break;
    }
}

- (void)firstFrame {
    _hasVideo = YES;
    [self hideStatus];
    AppDelegate *app = (AppDelegate *)[UIApplication sharedApplication].delegate;
    NSURL *pending = app.pendingOpenURL;
    if (pending) {
        app.pendingOpenURL = nil;
        [self uploadFileAtURL:pending name:pending.lastPathComponent deleteAfter:NO];
    }
}

#pragma mark - input

- (void)sendNav:(SDNav)nav {
    uint8_t b = nav;
    [self.connection send:SDMsgNav payload:[NSData dataWithBytes:&b length:1]];
}

- (void)pressKey:(int)code {
    uint8_t b[9] = {2, (uint8_t)(code >> 24), (uint8_t)(code >> 16), (uint8_t)(code >> 8), (uint8_t)code, 0, 0, 0, 0};
    [self.connection send:SDMsgKey payload:[NSData dataWithBytes:b length:9]];
}

- (int)freePointerId {
    NSSet *used = [NSSet setWithArray:_touchIds.allValues];
    for (int i = 0; i < 10; i++)
        if (![used containsObject:@(i)]) return i;
    return -1;
}

- (void)sendTouch:(SDTouchAction)action pointer:(int)pointer at:(CGPoint)p {
    CGRect r = [_videoView videoRect];
    if (CGRectIsEmpty(r)) return;
    double nx = MAX(0.0, MIN(1.0, (p.x - r.origin.x) / r.size.width));
    double ny = MAX(0.0, MIN(1.0, (p.y - r.origin.y) / r.size.height));
    uint16_t x = (uint16_t)lround(nx * 65535.0);
    uint16_t y = (uint16_t)lround(ny * 65535.0);
    uint8_t b[6] = {action, (uint8_t)pointer, (uint8_t)(x >> 8), (uint8_t)x, (uint8_t)(y >> 8), (uint8_t)y};
    [self.connection send:SDMsgTouch payload:[NSData dataWithBytes:b length:6]];
}

- (void)touchesBegan:(NSSet<UITouch *> *)touches withEvent:(UIEvent *)event {
    if (!_hasVideo) return;
    CGRect r = CGRectInset([_videoView videoRect], -4, -4);
    for (UITouch *t in touches) {
        CGPoint p = [t locationInView:_videoView];
        if (!CGRectContainsPoint(r, p)) continue;
        int pid = [self freePointerId];
        if (pid < 0) continue;
        _touchIds[[NSValue valueWithNonretainedObject:t]] = @(pid);
        [self sendTouch:SDTouchDown pointer:pid at:p];
    }
}

- (void)touchesMoved:(NSSet<UITouch *> *)touches withEvent:(UIEvent *)event {
    for (UITouch *t in touches) {
        NSNumber *pid = _touchIds[[NSValue valueWithNonretainedObject:t]];
        if (pid) [self sendTouch:SDTouchMove pointer:pid.intValue at:[t locationInView:_videoView]];
    }
}

- (void)endTouches:(NSSet<UITouch *> *)touches {
    for (UITouch *t in touches) {
        NSValue *key = [NSValue valueWithNonretainedObject:t];
        NSNumber *pid = _touchIds[key];
        if (!pid) continue;
        [self sendTouch:SDTouchUp pointer:pid.intValue at:[t locationInView:_videoView]];
        [_touchIds removeObjectForKey:key];
    }
}

- (void)touchesEnded:(NSSet<UITouch *> *)touches withEvent:(UIEvent *)event {
    [self endTouches:touches];
}

- (void)touchesCancelled:(NSSet<UITouch *> *)touches withEvent:(UIEvent *)event {
    [self endTouches:touches];
}

- (void)dragMenu:(UIPanGestureRecognizer *)pan {
    CGPoint d = [pan translationInView:self.view];
    _menuButton.center = CGPointMake(_menuButton.center.x + d.x, _menuButton.center.y + d.y);
    [pan setTranslation:CGPointZero inView:self.view];
    if (pan.state == UIGestureRecognizerStateEnded) [self.view setNeedsLayout];
}

#pragma mark - menu

- (void)addAction:(NSString *)title to:(UIAlertController *)menu style:(UIAlertActionStyle)style run:(void (^)(void))run {
    [menu addAction:[UIAlertAction actionWithTitle:title
                                             style:style
                                           handler:^(UIAlertAction *action) {
                                               run();
                                           }]];
}

- (void)showMenu {
    __weak SDStreamViewController *ws = self;
    UIAlertController *m = [UIAlertController alertControllerWithTitle:nil message:_server.name preferredStyle:UIAlertControllerStyleActionSheet];
    [self addAction:@"Keyboard" to:m style:UIAlertActionStyleDefault run:^{
        [ws showKeyboard];
    }];
    [self addAction:@"Back" to:m style:UIAlertActionStyleDefault run:^{
        [ws sendNav:SDNavBack];
    }];
    [self addAction:@"Home" to:m style:UIAlertActionStyleDefault run:^{
        [ws sendNav:SDNavHome];
    }];
    [self addAction:@"Recent apps" to:m style:UIAlertActionStyleDefault run:^{
        [ws sendNav:SDNavRecents];
    }];
    [self addAction:@"Notifications" to:m style:UIAlertActionStyleDefault run:^{
        [ws sendNav:SDNavNotifications];
    }];
    [self addAction:@"Send a file or app (.apk) to Android…" to:m style:UIAlertActionStyleDefault run:^{
        [ws pickDocument];
    }];
    [self addAction:@"Send a photo or video…" to:m style:UIAlertActionStyleDefault run:^{
        [ws pickPhoto];
    }];
    [self addAction:@"Get a file from Android…" to:m style:UIAlertActionStyleDefault run:^{
        [ws browseAndroidFiles];
    }];
    if ([UIPasteboard generalPasteboard].hasStrings) {
        [self addAction:@"Paste iPhone clipboard into Android" to:m style:UIAlertActionStyleDefault run:^{
            NSString *s = [UIPasteboard generalPasteboard].string;
            if (s.length) [ws.connection send:SDMsgClipboard payload:[s dataUsingEncoding:NSUTF8StringEncoding]];
        }];
    }
    if (_camera.running) {
        [self addAction:@"Stop camera" to:m style:UIAlertActionStyleDefault run:^{
            [ws stopCamera];
        }];
    } else {
        [self addAction:@"Use iPhone camera (back)" to:m style:UIAlertActionStyleDefault run:^{
            [ws startCamera:NO];
        }];
        [self addAction:@"Use iPhone camera (front)" to:m style:UIAlertActionStyleDefault run:^{
            [ws startCamera:YES];
        }];
    }
    [self addAction:@"Rotate Android screen" to:m style:UIAlertActionStyleDefault run:^{
        [ws sendNav:SDNavRotate];
    }];
    [self addAction:@"Restart Android" to:m style:UIAlertActionStyleDefault run:^{
        [ws confirmRestart];
    }];
    [self addAction:@"Disconnect" to:m style:UIAlertActionStyleDestructive run:^{
        [ws leave];
    }];
    [m addAction:[UIAlertAction actionWithTitle:@"Cancel" style:UIAlertActionStyleCancel handler:nil]];
    m.popoverPresentationController.sourceView = _menuButton;
    m.popoverPresentationController.sourceRect = _menuButton.bounds;
    [self presentViewController:m animated:YES completion:nil];
}

- (void)showKeyboard {
    [_keyboard becomeFirstResponder];
}

- (void)confirmRestart {
    UIAlertController *a = [UIAlertController alertControllerWithTitle:@"Restart Android?"
                                                               message:@"Open apps will close. It takes about a minute."
                                                        preferredStyle:UIAlertControllerStyleAlert];
    [a addAction:[UIAlertAction actionWithTitle:@"Cancel" style:UIAlertActionStyleCancel handler:nil]];
    [a addAction:[UIAlertAction actionWithTitle:@"Restart"
                                          style:UIAlertActionStyleDestructive
                                        handler:^(UIAlertAction *action) {
                                            [self sendNav:SDNavRestartAndroid];
                                        }]];
    [self presentViewController:a animated:YES completion:nil];
}

#pragma mark - camera

- (void)startCamera:(BOOL)front {
    if (!_cameraAvailable) {
        [self alert:@"Camera not available"
            message:_cameraReason ?: @"The server cannot pass the iPhone camera to Android. See the README (Linux + v4l2loopback)."
               then:nil];
        return;
    }
    __weak SDStreamViewController *ws = self;
    _camera.onFrame = ^(NSData *jpeg) {
        [ws sendCameraFrame:jpeg];
    };
    [_camera startWithFront:front
                 completion:^(NSString *error) {
                     SDStreamViewController *s = ws;
                     if (!s) return;
                     if (error) {
                         [s alert:@"Camera" message:error then:nil];
                         return;
                     }
                     [s showCameraPreview];
                     [s toast:@"Android now sees the iPhone camera as its back camera"];
                 }];
}

- (void)switchCamera {
    if (_camera.running) [self startCamera:!_camera.front];
}

- (void)showCameraPreview {
    [_previewLayer removeFromSuperlayer];
    _previewLayer = [AVCaptureVideoPreviewLayer layerWithSession:_camera.session];
    _previewLayer.videoGravity = AVLayerVideoGravityResizeAspectFill;
    _previewLayer.frame = _previewView.bounds;
    [_previewView.layer addSublayer:_previewLayer];
    _previewView.hidden = NO;
    [self.view bringSubviewToFront:_previewView];
    [self.view bringSubviewToFront:_menuButton];
}

- (void)stopCamera {
    BOOL wasRunning = _camera.running;
    [_camera stop];
    _camera.onFrame = nil;
    [_previewLayer removeFromSuperlayer];
    _previewLayer = nil;
    _previewView.hidden = YES;
    if (wasRunning) [self.connection send:SDMsgCameraStop payload:nil];
}

// Camera thread. At most two frames on their way, so a slow Wi-Fi never builds up a delay.
- (void)sendCameraFrame:(NSData *)jpeg {
    SDConnection *c = self.connection;
    if (!c || __atomic_load_n(&_cameraInFlight, __ATOMIC_SEQ_CST) >= 2) return;
    __atomic_fetch_add(&_cameraInFlight, 1, __ATOMIC_SEQ_CST);
    [c send:SDMsgCameraFrame
         payload:jpeg
      completion:^(BOOL ok) {
          __atomic_fetch_sub(&self->_cameraInFlight, 1, __ATOMIC_SEQ_CST);
      }];
}

#pragma mark - files: iPhone -> Android

- (void)pickDocument {
    UIDocumentPickerViewController *p = [[UIDocumentPickerViewController alloc] initWithDocumentTypes:@[ (__bridge NSString *)kUTTypeItem ]
                                                                                               inMode:UIDocumentPickerModeImport];
    p.delegate = self;
    [self presentViewController:p animated:YES completion:nil];
}

- (void)documentPicker:(UIDocumentPickerViewController *)controller didPickDocumentsAtURLs:(NSArray<NSURL *> *)urls {
    NSURL *url = urls.firstObject;
    if (url) [self uploadFileAtURL:url name:url.lastPathComponent deleteAfter:YES];
}

- (void)pickPhoto {
    if (![UIImagePickerController isSourceTypeAvailable:UIImagePickerControllerSourceTypePhotoLibrary]) return;
    UIImagePickerController *p = [UIImagePickerController new];
    p.sourceType = UIImagePickerControllerSourceTypePhotoLibrary;
    p.mediaTypes = @[ (__bridge NSString *)kUTTypeImage, (__bridge NSString *)kUTTypeMovie ];
    p.videoQuality = UIImagePickerControllerQualityTypeHigh;
    p.videoExportPreset = AVAssetExportPresetPassthrough;
    p.delegate = self;
    p.modalPresentationStyle = UIModalPresentationPopover;  // required on iPad, full screen on iPhone
    p.popoverPresentationController.sourceView = _menuButton;
    p.popoverPresentationController.sourceRect = _menuButton.bounds;
    [self presentViewController:p animated:YES completion:nil];
}

- (NSString *)timestampName:(NSString *)prefix extension:(NSString *)ext {
    NSDateFormatter *f = [NSDateFormatter new];
    f.dateFormat = @"yyyyMMdd_HHmmss";
    f.locale = [NSLocale localeWithLocaleIdentifier:@"en_US_POSIX"];
    return [NSString stringWithFormat:@"%@_%@.%@", prefix, [f stringFromDate:[NSDate date]], ext.length ? ext : @"jpg"];
}

- (void)imagePickerController:(UIImagePickerController *)picker didFinishPickingMediaWithInfo:(NSDictionary<UIImagePickerControllerInfoKey, id> *)info {
    NSURL *movie = info[UIImagePickerControllerMediaURL];
    NSURL *imageURL = info[UIImagePickerControllerImageURL];
    UIImage *image = info[UIImagePickerControllerOriginalImage];
    [picker dismissViewControllerAnimated:YES
                               completion:^{
                                   if (movie) {
                                       NSString *name = [self timestampName:@"VID" extension:movie.pathExtension.lowercaseString];
                                       [self uploadFileAtURL:movie name:name deleteAfter:YES];
                                   } else if (imageURL) {
                                       NSString *name = [self timestampName:@"IMG" extension:imageURL.pathExtension.lowercaseString];
                                       [self uploadFileAtURL:imageURL name:name deleteAfter:NO];
                                   } else if (image) {
                                       NSString *name = [self timestampName:@"IMG" extension:@"jpg"];
                                       NSURL *tmp = [NSURL fileURLWithPath:[NSTemporaryDirectory() stringByAppendingPathComponent:name]];
                                       [UIImageJPEGRepresentation(image, 0.92) writeToURL:tmp atomically:YES];
                                       [self uploadFileAtURL:tmp name:name deleteAfter:YES];
                                   }
                               }];
}

- (void)imagePickerControllerDidCancel:(UIImagePickerController *)picker {
    [picker dismissViewControllerAnimated:YES completion:nil];
}

- (void)openFileNotification:(NSNotification *)note {
    AppDelegate *app = (AppDelegate *)[UIApplication sharedApplication].delegate;
    NSURL *url = app.pendingOpenURL;
    if (!url || !_hasVideo) return;  // sent after the screen shows up
    app.pendingOpenURL = nil;
    [self uploadFileAtURL:url name:url.lastPathComponent deleteAfter:NO];
}

- (void)uploadFileAtURL:(NSURL *)url name:(NSString *)name deleteAfter:(BOOL)deleteAfter {
    SDConnection *c = self.connection;
    if (!c.connected) {
        [self toast:@"Not connected to the server."];
        return;
    }
    if (_uploading) {
        [self toast:@"Please wait until the current file is sent."];
        return;
    }
    _uploading = YES;
    BOOL scoped = [url startAccessingSecurityScopedResource];
    [self toast:[NSString stringWithFormat:@"Sending %@…", name]];
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
        NSString *problem = nil;
        NSError *error = nil;
        NSFileHandle *handle = [NSFileHandle fileHandleForReadingFromURL:url error:&error];
        unsigned long long size = [[[NSFileManager defaultManager] attributesOfItemAtPath:url.path error:nil] fileSize];
        if (!handle) {
            problem = [NSString stringWithFormat:@"Could not read %@.", name];
        } else {
            NSData *begin = [NSJSONSerialization dataWithJSONObject:@{@"name" : name ?: @"file", @"size" : @(size)} options:0 error:nil];
            if (![c sendSync:SDMsgUploadBegin payload:begin]) problem = @"The connection was lost.";
            unsigned long long sent = 0;
            CFTimeInterval last = CACurrentMediaTime();
            while (!problem) {
                @autoreleasepool {
                    NSData *chunk = [handle readDataOfLength:256 * 1024];
                    if (chunk.length == 0) break;
                    if (![c sendSync:SDMsgUploadChunk payload:chunk]) {
                        problem = @"The connection was lost.";
                        break;
                    }
                    sent += chunk.length;
                    CFTimeInterval now = CACurrentMediaTime();
                    if (size > 0 && now - last > 0.7) {
                        last = now;
                        int pct = (int)(sent * 100 / size);
                        dispatch_async(dispatch_get_main_queue(), ^{
                            [self toast:[NSString stringWithFormat:@"Sending %@… %d%%", name, pct]];
                        });
                    }
                }
            }
            [handle closeFile];
            if (!problem && ![c sendSync:SDMsgUploadEnd payload:nil]) problem = @"The connection was lost.";
        }
        if (scoped) [url stopAccessingSecurityScopedResource];
        if (deleteAfter) [[NSFileManager defaultManager] removeItemAtURL:url error:nil];
        dispatch_async(dispatch_get_main_queue(), ^{
            self->_uploading = NO;
            BOOL isApp = [name.lowercaseString hasSuffix:@".apk"] || [name.lowercaseString hasSuffix:@".apks"] || [name.lowercaseString hasSuffix:@".xapk"];
            [self toast:problem ?: (isApp ? [NSString stringWithFormat:@"Installing %@…", name] : [NSString stringWithFormat:@"Sent %@", name])];
        });
    });
}

#pragma mark - files: Android -> iPhone

- (void)browseAndroidFiles {
    __weak SDStreamViewController *ws = self;
    SDFileBrowserViewController *b = [[SDFileBrowserViewController alloc] initWithPath:@"/sdcard/"];
    b.requestListing = ^(SDFileBrowserViewController *browser, NSString *path) {
        SDStreamViewController *s = ws;
        if (!s) return;
        s->_browser = browser;
        [s.connection sendJSON:SDMsgListFiles object:@{@"path" : path}];
    };
    b.pickFile = ^(NSString *path) {
        [ws.connection sendJSON:SDMsgDownload object:@{@"path" : path}];
        [ws toast:[NSString stringWithFormat:@"Getting %@…", path.lastPathComponent]];
    };
    UINavigationController *nav = [[UINavigationController alloc] initWithRootViewController:b];
    [self presentViewController:nav animated:YES completion:nil];
}

- (NSString *)downloadFolder {
    NSString *docs = NSSearchPathForDirectoriesInDomains(NSDocumentDirectory, NSUserDomainMask, YES).firstObject;
    NSString *dir = [docs stringByAppendingPathComponent:@"From Android"];
    [[NSFileManager defaultManager] createDirectoryAtPath:dir withIntermediateDirectories:YES attributes:nil error:nil];
    return dir;
}

// Connection thread.
- (void)downloadBegin:(NSDictionary *)info {
    [_downloadHandle closeFile];
    NSString *name = [(SDString(info[@"name"]) ?: @"file") lastPathComponent];
    if (name.length == 0 || [name hasPrefix:@"."]) name = @"file";
    NSString *dir = [self downloadFolder];
    NSString *path = [dir stringByAppendingPathComponent:name];
    NSFileManager *fm = [NSFileManager defaultManager];
    for (int i = 2; [fm fileExistsAtPath:path] && i < 1000; i++) {
        NSString *base = [name stringByDeletingPathExtension];
        NSString *ext = name.pathExtension;
        NSString *candidate = [NSString stringWithFormat:@"%@ (%d)", base, i];
        if (ext.length) candidate = [candidate stringByAppendingPathExtension:ext];
        path = [dir stringByAppendingPathComponent:candidate];
    }
    [fm createFileAtPath:path contents:nil attributes:nil];
    _downloadHandle = [NSFileHandle fileHandleForWritingAtPath:path];
    _downloadPath = path;
    _downloadName = name;
    _downloadSize = [info[@"size"] longLongValue];
    _downloadReceived = 0;
    _downloadLastUpdate = 0;
}

- (void)downloadChunk:(NSData *)data {
    if (!_downloadHandle) return;
    [_downloadHandle writeData:data];
    _downloadReceived += (long long)data.length;
    CFTimeInterval now = CACurrentMediaTime();
    if (_downloadSize > 0 && now - _downloadLastUpdate > 0.7) {
        _downloadLastUpdate = now;
        int pct = (int)(_downloadReceived * 100 / _downloadSize);
        NSString *name = _downloadName;
        dispatch_async(dispatch_get_main_queue(), ^{
            [self toast:[NSString stringWithFormat:@"Getting %@… %d%%", name, pct]];
        });
    }
}

- (void)downloadEnd:(NSDictionary *)info {
    [_downloadHandle closeFile];
    _downloadHandle = nil;
    NSString *path = _downloadPath;
    _downloadPath = nil;
    BOOL ok = [info[@"ok"] boolValue] && path;
    NSString *message = SDString(info[@"message"]);
    if (!ok && path) [[NSFileManager defaultManager] removeItemAtPath:path error:nil];
    dispatch_async(dispatch_get_main_queue(), ^{
        if (!ok) {
            [self toast:[NSString stringWithFormat:@"Could not get the file: %@", message ?: @"unknown error"]];
            return;
        }
        [self toast:@"Saved in Files > On My iPhone > Sandroid > From Android"];
        UIActivityViewController *share = [[UIActivityViewController alloc] initWithActivityItems:@[ [NSURL fileURLWithPath:path] ]
                                                                            applicationActivities:nil];
        share.popoverPresentationController.sourceView = self.view;
        share.popoverPresentationController.sourceRect = CGRectMake(self.view.bounds.size.width / 2, self.view.bounds.size.height / 2, 1, 1);
        [self presentViewController:share animated:YES completion:nil];
    });
}

@end
