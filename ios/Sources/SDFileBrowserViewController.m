#import "SDFileBrowserViewController.h"

@implementation SDFileBrowserViewController {
    NSArray<NSDictionary *> *_entries;
    NSString *_message;
}

- (instancetype)initWithPath:(NSString *)path {
    if ((self = [super initWithStyle:UITableViewStylePlain])) {
        _path = [path hasSuffix:@"/"] ? [path copy] : [path stringByAppendingString:@"/"];
        _message = @"Loading…";
        NSString *last = [[_path substringToIndex:_path.length - 1] lastPathComponent];
        self.title = [_path isEqualToString:@"/sdcard/"] ? @"Android files" : last;
    }
    return self;
}

- (void)viewDidLoad {
    [super viewDidLoad];
    self.navigationItem.rightBarButtonItem = [[UIBarButtonItem alloc] initWithBarButtonSystemItem:UIBarButtonSystemItemDone
                                                                                           target:self
                                                                                           action:@selector(close)];
    self.tableView.rowHeight = 52;
}

- (void)viewWillAppear:(BOOL)animated {
    [super viewWillAppear:animated];
    if (self.requestListing) self.requestListing(self, self.path);
}

- (void)close {
    [self.navigationController dismissViewControllerAnimated:YES completion:nil];
}

- (void)showListing:(NSDictionary *)listing {
    if ([listing[@"error"] isKindOfClass:[NSString class]]) {
        _entries = @[];
        _message = listing[@"error"];
    } else {
        NSArray *entries = [listing[@"entries"] isKindOfClass:[NSArray class]] ? listing[@"entries"] : @[];
        _entries = entries;
        _message = entries.count ? nil : @"This folder is empty.";
    }
    [self.tableView reloadData];
}

- (NSInteger)tableView:(UITableView *)tableView numberOfRowsInSection:(NSInteger)section {
    return _message ? 1 : (NSInteger)_entries.count;
}

- (UITableViewCell *)tableView:(UITableView *)tableView cellForRowAtIndexPath:(NSIndexPath *)indexPath {
    UITableViewCell *cell = [tableView dequeueReusableCellWithIdentifier:@"f"];
    if (!cell) cell = [[UITableViewCell alloc] initWithStyle:UITableViewCellStyleDefault reuseIdentifier:@"f"];
    if (_message) {
        cell.textLabel.text = _message;
        cell.textLabel.textColor = [UIColor grayColor];
        cell.accessoryType = UITableViewCellAccessoryNone;
        cell.selectionStyle = UITableViewCellSelectionStyleNone;
        return cell;
    }
    NSDictionary *e = _entries[(NSUInteger)indexPath.row];
    BOOL dir = [e[@"dir"] boolValue];
    cell.textLabel.text = [NSString stringWithFormat:@"%@ %@", dir ? @"\U0001F4C1" : @"\U0001F4C4", e[@"name"]];
    cell.textLabel.textColor = [UIColor blackColor];
    cell.accessoryType = dir ? UITableViewCellAccessoryDisclosureIndicator : UITableViewCellAccessoryNone;
    cell.selectionStyle = UITableViewCellSelectionStyleDefault;
    return cell;
}

- (void)tableView:(UITableView *)tableView didSelectRowAtIndexPath:(NSIndexPath *)indexPath {
    [tableView deselectRowAtIndexPath:indexPath animated:YES];
    if (_message) return;
    NSDictionary *e = _entries[(NSUInteger)indexPath.row];
    NSString *full = [self.path stringByAppendingString:e[@"name"]];
    if ([e[@"dir"] boolValue]) {
        SDFileBrowserViewController *next = [[SDFileBrowserViewController alloc] initWithPath:full];
        next.requestListing = self.requestListing;
        next.pickFile = self.pickFile;
        [self.navigationController pushViewController:next animated:YES];
    } else {
        void (^pick)(NSString *) = self.pickFile;
        [self.navigationController dismissViewControllerAnimated:YES
                                                      completion:^{
                                                          if (pick) pick(full);
                                                      }];
    }
}

@end
