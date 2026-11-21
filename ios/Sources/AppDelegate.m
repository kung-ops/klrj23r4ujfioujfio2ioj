#import "AppDelegate.h"
#import "SDConnectViewController.h"

NSString *const SDOpenFileNotification = @"SDOpenFileNotification";

@implementation AppDelegate

- (BOOL)application:(UIApplication *)application didFinishLaunchingWithOptions:(NSDictionary *)launchOptions {
    self.window = [[UIWindow alloc] initWithFrame:[UIScreen mainScreen].bounds];
    UINavigationController *nav = [[UINavigationController alloc] initWithRootViewController:[SDConnectViewController new]];
    nav.navigationBar.tintColor = [UIColor colorWithRed:0.20 green:0.66 blue:0.33 alpha:1];
    self.window.rootViewController = nav;
    self.window.backgroundColor = [UIColor blackColor];
    [self.window makeKeyAndVisible];
    return YES;
}

- (BOOL)application:(UIApplication *)app openURL:(NSURL *)url options:(NSDictionary<UIApplicationOpenURLOptionsKey, id> *)options {
    if (!url.isFileURL) return NO;
    self.pendingOpenURL = url;
    [[NSNotificationCenter defaultCenter] postNotificationName:SDOpenFileNotification object:url];
    return YES;
}

@end
