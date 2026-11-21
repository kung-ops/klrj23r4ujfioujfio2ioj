#import <UIKit/UIKit.h>

@class SDFileBrowserViewController;

// Browses the Android storage (/sdcard) and picks a file to copy to the iPhone.
@interface SDFileBrowserViewController : UITableViewController

- (instancetype)initWithPath:(NSString *)path;

@property (nonatomic, readonly) NSString *path;
// Asks the server for a folder listing; the answer comes back through -showListing:.
@property (nonatomic, copy) void (^requestListing)(SDFileBrowserViewController *browser, NSString *path);
@property (nonatomic, copy) void (^pickFile)(NSString *path);

- (void)showListing:(NSDictionary *)listing;

@end
