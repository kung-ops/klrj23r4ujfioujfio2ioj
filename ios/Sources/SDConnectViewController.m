#import "SDConnectViewController.h"
#import "SDDiscovery.h"
#import "SDStreamViewController.h"

static NSString *const kRecentKey = @"sandroid.recent";

@interface SDConnectViewController () <SDDiscoveryDelegate>
@end

@implementation SDConnectViewController {
    SDDiscovery *_discovery;
    NSMutableArray<SDServer *> *_found;
    SDServer *_recent;
}

- (instancetype)init {
    if ((self = [super initWithStyle:UITableViewStyleGrouped])) {
        self.title = @"Sandroid";
        _found = [NSMutableArray array];
        _discovery = [SDDiscovery new];
        _discovery.delegate = self;
    }
    return self;
}

- (void)viewDidLoad {
    [super viewDidLoad];
    self.tableView.rowHeight = 60;
}

- (void)viewWillAppear:(BOOL)animated {
    [super viewWillAppear:animated];
    _recent = [SDServer fromDictionary:[[NSUserDefaults standardUserDefaults] dictionaryForKey:kRecentKey]];
    [_found removeAllObjects];
    [self.tableView reloadData];
    [_discovery start];
}

- (void)viewWillDisappear:(BOOL)animated {
    [super viewWillDisappear:animated];
    [_discovery stop];
}

- (void)discovery:(SDDiscovery *)discovery didFindServer:(SDServer *)server {
    for (NSUInteger i = 0; i < _found.count; i++) {
        if ([_found[i].key isEqualToString:server.key]) {
            _found[i] = server;
            [self.tableView reloadData];
            return;
        }
    }
    [_found addObject:server];
    [self.tableView reloadData];
}

#pragma mark - table

- (NSInteger)numberOfSectionsInTableView:(UITableView *)tableView {
    return 2;
}

- (NSString *)tableView:(UITableView *)tableView titleForHeaderInSection:(NSInteger)section {
    return section == 0 ? @"Computers on this Wi-Fi" : @"Other";
}

- (NSString *)tableView:(UITableView *)tableView titleForFooterInSection:(NSInteger)section {
    if (section == 0) {
        return @"Start the Sandroid server on your computer (node server.js). The computer and this iPhone must be on the same Wi-Fi. "
               @"The PIN is shown in the server window.";
    }
    return nil;
}

- (BOOL)showRecent {
    if (!_recent) return NO;
    for (SDServer *s in _found)
        if ([s.key isEqualToString:_recent.key]) return NO;
    return YES;
}

- (NSInteger)tableView:(UITableView *)tableView numberOfRowsInSection:(NSInteger)section {
    if (section == 0) return MAX((NSInteger)_found.count, 1);
    return [self showRecent] ? 2 : 1;
}

- (UITableViewCell *)tableView:(UITableView *)tableView cellForRowAtIndexPath:(NSIndexPath *)indexPath {
    UITableViewCell *cell = [[UITableViewCell alloc] initWithStyle:UITableViewCellStyleSubtitle reuseIdentifier:nil];
    cell.detailTextLabel.textColor = [UIColor grayColor];
    if (indexPath.section == 0) {
        if (_found.count == 0) {
            cell.textLabel.text = @"Searching…";
            cell.detailTextLabel.text = @"Looking for a Sandroid server on port 8080";
            UIActivityIndicatorView *spin = [[UIActivityIndicatorView alloc] initWithActivityIndicatorStyle:UIActivityIndicatorViewStyleGray];
            [spin startAnimating];
            cell.accessoryView = spin;
            cell.selectionStyle = UITableViewCellSelectionStyleNone;
            return cell;
        }
        SDServer *s = _found[(NSUInteger)indexPath.row];
        cell.textLabel.text = [NSString stringWithFormat:@"\U0001F4BB %@", s.name];
        NSString *phase = @"";
        if ([s.phase isEqualToString:@"ready"]) phase = @" · Android ready";
        else if ([s.phase isEqualToString:@"installing"]) phase = @" · installing Android";
        else if ([s.phase isEqualToString:@"booting"]) phase = @" · starting Android";
        else if ([s.phase isEqualToString:@"error"]) phase = @" · has a problem";
        cell.detailTextLabel.text = [s.displayAddress stringByAppendingString:phase];
        cell.accessoryType = UITableViewCellAccessoryDisclosureIndicator;
        return cell;
    }
    if (indexPath.row == 0) {
        cell.textLabel.text = @"Enter address…";
        cell.detailTextLabel.text = @"For example 192.168.1.20 (port 8080)";
    } else {
        cell.textLabel.text = [NSString stringWithFormat:@"Last used: %@", _recent.name];
        cell.detailTextLabel.text = _recent.displayAddress;
    }
    cell.accessoryType = UITableViewCellAccessoryDisclosureIndicator;
    return cell;
}

- (void)tableView:(UITableView *)tableView didSelectRowAtIndexPath:(NSIndexPath *)indexPath {
    [tableView deselectRowAtIndexPath:indexPath animated:YES];
    if (indexPath.section == 0) {
        if (_found.count) [self openServer:_found[(NSUInteger)indexPath.row]];
    } else if (indexPath.row == 0) {
        [self askAddress];
    } else {
        [self openServer:_recent];
    }
}

#pragma mark - connecting

- (void)askAddress {
    UIAlertController *a = [UIAlertController alertControllerWithTitle:@"Server address"
                                                               message:@"The IP address shown in the server window."
                                                        preferredStyle:UIAlertControllerStyleAlert];
    [a addTextFieldWithConfigurationHandler:^(UITextField *field) {
        field.placeholder = @"192.168.1.20";
        field.keyboardType = UIKeyboardTypeNumbersAndPunctuation;
        field.autocorrectionType = UITextAutocorrectionTypeNo;
        field.autocapitalizationType = UITextAutocapitalizationTypeNone;
    }];
    [a addAction:[UIAlertAction actionWithTitle:@"Cancel" style:UIAlertActionStyleCancel handler:nil]];
    __weak UIAlertController *weakAlert = a;
    [a addAction:[UIAlertAction actionWithTitle:@"Connect"
                                          style:UIAlertActionStyleDefault
                                        handler:^(UIAlertAction *action) {
                                            SDServer *s = [SDServer serverFromAddress:weakAlert.textFields.firstObject.text];
                                            if (s) [self openServer:s];
                                        }]];
    [self presentViewController:a animated:YES completion:nil];
}

+ (NSString *)pinKeyFor:(SDServer *)server {
    return [@"sandroid.pin." stringByAppendingString:server.key];
}

- (void)openServer:(SDServer *)server {
    NSString *pin = [[NSUserDefaults standardUserDefaults] stringForKey:[SDConnectViewController pinKeyFor:server]];
    if (pin.length) {
        [self startStream:server pin:pin];
        return;
    }
    UIAlertController *a = [UIAlertController alertControllerWithTitle:@"PIN"
                                                               message:[NSString stringWithFormat:@"Type the PIN shown in the server window on %@.", server.name]
                                                        preferredStyle:UIAlertControllerStyleAlert];
    [a addTextFieldWithConfigurationHandler:^(UITextField *field) {
        field.placeholder = @"6 digits";
        field.keyboardType = UIKeyboardTypeNumberPad;
    }];
    [a addAction:[UIAlertAction actionWithTitle:@"Cancel" style:UIAlertActionStyleCancel handler:nil]];
    __weak UIAlertController *weakAlert = a;
    [a addAction:[UIAlertAction actionWithTitle:@"Connect"
                                          style:UIAlertActionStyleDefault
                                        handler:^(UIAlertAction *action) {
                                            NSString *typed = [weakAlert.textFields.firstObject.text
                                                stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceCharacterSet]];
                                            if (typed.length == 0) return;
                                            [[NSUserDefaults standardUserDefaults] setObject:typed forKey:[SDConnectViewController pinKeyFor:server]];
                                            [self startStream:server pin:typed];
                                        }]];
    [self presentViewController:a animated:YES completion:nil];
}

- (void)startStream:(SDServer *)server pin:(NSString *)pin {
    [[NSUserDefaults standardUserDefaults] setObject:server.dictionary forKey:kRecentKey];
    SDStreamViewController *stream = [[SDStreamViewController alloc] initWithServer:server pin:pin];
    stream.onWrongPin = ^{
        [[NSUserDefaults standardUserDefaults] removeObjectForKey:[SDConnectViewController pinKeyFor:server]];
    };
    stream.modalPresentationStyle = UIModalPresentationFullScreen;
    [self presentViewController:stream animated:YES completion:nil];
}

@end
