#import <UIKit/UIKit.h>

// Posted when another app opens a file in Sandroid ("Open in…" / Share), e.g. an .apk to install.
extern NSString *const SDOpenFileNotification;

@interface AppDelegate : UIResponder <UIApplicationDelegate>
@property (nonatomic, strong) UIWindow *window;
@property (nonatomic, strong) NSURL *pendingOpenURL;
@end
