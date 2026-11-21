#import <UIKit/UIKit.h>

@class SDServer;

// Full-screen Android: video, sound, touch, keyboard, files and camera.
@interface SDStreamViewController : UIViewController
- (instancetype)initWithServer:(SDServer *)server pin:(NSString *)pin;
@property (nonatomic, copy) void (^onWrongPin)(void);
@end
