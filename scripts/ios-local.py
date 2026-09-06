#!/usr/bin/env python3
"""Build, install, and compare a private iOS app using a durable local ledger."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
STATE = ROOT / '.t3/ios'
SOURCE = STATE / 'source'
DEVICE = 'CF4845A2-5ACF-5346-8123-49892EDAE92A'
BUNDLE = 'nz.co.hamishgilbert.t3code'
SCHEME = 'T3CodeSelfHosted'
NOTIFICATION_POLICY = {
    'notifyOnApproval': True,
    'notifyOnInput': True,
    'notifyOnCompletion': False,
    'notifyOnFailure': True,
}
INPUTS = ['apps/mobile', 'packages', 'patches', 'assets', 'scripts/lib',
          'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']


def check_source_policy(source=SOURCE):
    """Fail closed when upstream reintroduces iOS Live Activity integration."""
    mobile = source / 'apps/mobile'
    dependencies = json.loads((mobile / 'package.json').read_text())['dependencies']
    if 'expo-widgets' in dependencies or 'expo-notifications' not in dependencies:
        raise RuntimeError('Private iOS policy requires push notifications without expo-widgets.')
    files = [mobile / 'app.config.ts']
    for directory in ['src', 'plugins', 'modules']:
        files.extend(path for path in (mobile / directory).rglob('*')
                     if path.is_file() and path.suffix in {'.ts', '.tsx', '.swift', '.m', '.mm', '.cjs'}
                     and 'node_modules' not in path.parts and '.test.' not in path.name)
    forbidden = re.compile(r'expo-widgets|ActivityKit|DynamicIsland|pushToStartToken|'
                           r'armAgentAwarenessLiveActivity|registerDirectLiveActivity|'
                           r'registerLiveActivityPushToken|startLiveActivity')
    for path in files:
        text = path.read_text()
        # The wire contract still needs an explicit opt-out for existing servers.
        without_opt_out = re.sub(r'liveActivitiesEnabled\s*:\s*false\b', '', text)
        if forbidden.search(text) or 'liveActivitiesEnabled' in without_opt_out:
            raise RuntimeError('Live Activity code violates private iOS policy: ' + str(path))
    registration = (mobile / 'src/features/agent-awareness/registrationPayload.ts').read_text()
    if not re.search(r'liveActivitiesEnabled\s*:\s*false\b', registration):
        raise RuntimeError('APNs device registration must explicitly disable Live Activities.')
    for preference, enabled in NOTIFICATION_POLICY.items():
        values = re.findall(r'\b' + preference + r'\s*:\s*([^,\n}]+)', registration)
        if [value.strip() for value in values] != [str(enabled).lower()]:
            raise RuntimeError('Private attention-only notification policy changed: ' + preference)


def check_native_policy(native):
    if not (native / (SCHEME + '.xcworkspace/contents.xcworkspacedata')).is_file():
        raise RuntimeError('iOS workspace is missing. Run pod install after Expo prebuild.')
    info = plistlib.loads((native / SCHEME / 'Info.plist').read_bytes())
    entitlement = plistlib.loads((native / SCHEME / (SCHEME + '.entitlements')).read_bytes())
    project = (native / (SCHEME + '.xcodeproj/project.pbxproj')).read_text()
    if info.get('NSSupportsLiveActivities') or info.get('NSSupportsLiveActivitiesFrequentUpdates'):
        raise RuntimeError('Generated iOS project enables Live Activities. Regenerate it.')
    if 'ExpoWidgets' in project or 'ActivityKit' in project:
        raise RuntimeError('Generated iOS project still contains a Live Activity target.')
    if entitlement.get('aps-environment') != 'development':
        raise RuntimeError('Private iOS build must preserve sandbox APNs entitlement.')


def check_artifact_policy(artifact):
    info = plistlib.loads((artifact / 'Info.plist').read_bytes())
    if info.get('NSSupportsLiveActivities') or info.get('NSSupportsLiveActivitiesFrequentUpdates'):
        raise RuntimeError('Built app enables Live Activities; refusing installation.')
    for extension in artifact.rglob('*.appex'):
        extension_info = plistlib.loads((extension / 'Info.plist').read_bytes())
        if extension_info.get('NSExtension', {}).get('NSExtensionPointIdentifier') == 'com.apple.widgetkit-extension':
            raise RuntimeError('Built app contains a widget/Live Activity extension.')
    if any(artifact.rglob('ExpoWidgets.framework')):
        raise RuntimeError('Built app contains the Live Activity SDK.')


def update():
    if run('git', 'status', '--porcelain'):
        raise RuntimeError('Commit the private iOS changes before updating; they must survive the merge.')
    run('git', 'fetch', 'upstream', 'main')
    subprocess.run(['git', 'merge', '--no-edit', 'upstream/main'], cwd=SOURCE, check=True)
    check_source_policy()
    print('Upstream merged; private iOS policy passed. Install dependencies and regenerate iOS before building.')


def run(*args, cwd=SOURCE):
    return subprocess.check_output(args, cwd=cwd, text=True).strip()


def save(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(data, indent=2) + '\n')
    temporary.replace(path)


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def fingerprint():
    digest = hashlib.sha256()
    names = run('git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard',
                '--', *INPUTS).split('\0')
    for name in sorted(set(filter(None, names))):
        path = SOURCE / name
        digest.update(name.encode() + b'\0')
        if path.is_symlink():
            digest.update(os.readlink(path).encode())
        elif path.is_file():
            digest.update(path.read_bytes())
        else:
            digest.update(b'<deleted>')
        digest.update(b'\0')
    return digest.hexdigest()


def installed_app():
    with tempfile.TemporaryDirectory(prefix='t3-ios-device-') as temporary:
        output = Path(temporary) / 'apps.json'
        run('xcrun', 'devicectl', '--timeout', '30', 'device', 'info', 'apps', '--device', DEVICE,
            '--json-output', str(output))
        apps = json.loads(output.read_text())['result']['apps']
        return next((app for app in apps if app['bundleIdentifier'] == BUNDLE), None)


def status(fetch):
    if fetch:
        run('git', 'fetch', 'upstream', 'main')
    print('Source:', SOURCE)
    print('Upstream:', run('git', 'log', '-1', '--format=%h %s', 'upstream/main'))
    builds = list((STATE / 'builds').glob('*/record.json'))
    if builds:
        latest = max(builds, key=lambda path: int(path.parent.name))
        build_record = json.loads(latest.read_text())
        print('Latest build:', build_record['buildNumber'], build_record['status'])
        print('Build log:', latest.parent / 'build.log')
    ledger = STATE / 'installed.json'
    if not ledger.exists():
        print('No verified installation recorded yet.')
        return
    record = json.loads(ledger.read_text())
    print('Recorded install:', record['version'], 'build', record['buildNumber'],
          'at', record['installedAt'])
    print('Installed source:', record['sourceRevision'])
    print('Local mobile inputs changed:', fingerprint() != record['sourceFingerprint'])
    app = installed_app()
    matches = bool(app and app['version'] == record['version']
                   and app['bundleVersion'] == record['buildNumber'])
    print('Phone version matches record:', matches)
    if not matches:
        print('Installed source is unknown; the phone no longer matches the recorded build.')
    changes = run('git', 'log', '--oneline', record['sourceRevision'] + '..upstream/main',
                  '--', *INPUTS)
    print('Upstream changes affecting mobile inputs:\n' + (changes or 'None.'))


def build():
    check_source_policy()
    check_native_policy(SOURCE / 'apps/mobile/ios')
    app = installed_app()
    numbers = [int(app['bundleVersion']) if app and app['bundleVersion'].isdigit() else 1]
    for path in (STATE / 'builds').glob('*/record.json'):
        numbers.append(int(json.loads(path.read_text())['buildNumber']))
    number = str(max(numbers) + 1)
    directory = STATE / 'builds' / number
    directory.mkdir(parents=True)
    record = {'sourceRevision': run('git', 'rev-parse', 'HEAD'),
              'upstreamRevision': run('git', 'merge-base', 'HEAD', 'upstream/main'),
              'sourceFingerprint': fingerprint(), 'buildNumber': number,
              'device': DEVICE, 'bundleIdentifier': BUNDLE, 'startedAt': now(),
              'source': str(SOURCE), 'status': 'building'}
    (directory / 'source.patch').write_text(run('git', 'diff', '--binary', record['upstreamRevision']))
    save(directory / 'record.json', record)
    with (directory / 'build.log').open('w') as log:
        worker = subprocess.Popen([str(Path.home() / '.claude/hooks/build-lock'),
                                   sys.executable, str(Path(__file__).resolve()),
                                   '_build', number], stdout=log, stderr=subprocess.STDOUT,
                                  start_new_session=True, stdin=subprocess.DEVNULL)
    print('Started build', number, 'PID', worker.pid, 'log:', directory / 'build.log')


def worker(number):
    directory = STATE / 'builds' / number
    path = directory / 'record.json'
    record = json.loads(path.read_text())
    try:
        native = SOURCE / 'apps/mobile/ios'
        check_source_policy()
        check_native_policy(native)
        with (directory / 'validation.log').open('w') as validation:
            subprocess.run([str(SOURCE / 'apps/mobile/node_modules/.bin/tsc'), '--noEmit'],
                           cwd=SOURCE / 'apps/mobile', stdout=validation,
                           stderr=subprocess.STDOUT, check=True)
            subprocess.run([str(SOURCE / 'node_modules/.bin/vp'), 'test', 'run',
                            'apps/mobile/src/features/agent-awareness/remoteRegistration.test.ts',
                            'apps/mobile/src/features/cloud/linkEnvironment.test.ts'],
                           cwd=SOURCE, stdout=validation, stderr=subprocess.STDOUT, check=True)
        info_path = native / SCHEME / 'Info.plist'
        with info_path.open('rb') as stream:
            info = plistlib.load(stream)
        info.update(CFBundleVersion=number, T3SourceRevision=record['sourceRevision'],
                    T3SourceFingerprint=record['sourceFingerprint'])
        with info_path.open('wb') as stream:
            plistlib.dump(info, stream)
        artifact = STATE / 'DerivedData/Build/Products/Release-iphoneos' / (SCHEME + '.app')
        # Keep compilation caches but never carry removed extensions into a new app.
        if artifact.exists():
            shutil.rmtree(artifact)
        environment = dict(os.environ, APP_VARIANT='production')
        subprocess.run([str(Path.home() / '.claude/hooks/build-lock'), 'xcodebuild',
                        '-workspace', str(native / (SCHEME + '.xcworkspace')),
                        '-scheme', SCHEME, '-configuration', 'Release',
                        '-destination', 'generic/platform=iOS', '-derivedDataPath', str(STATE / 'DerivedData'),
                        '-allowProvisioningUpdates', '-jobs', '2', 'build'],
                       cwd=SOURCE, env=environment, check=True)
        subprocess.run(['ditto', str(artifact), str(directory / artifact.name)], check=True)
        with (artifact / 'Info.plist').open('rb') as stream:
            built = plistlib.load(stream)
        if fingerprint() != record['sourceFingerprint']:
            raise RuntimeError('Source changed during build; refusing to record a valid artifact.')
        if built['CFBundleIdentifier'] != BUNDLE or built['CFBundleVersion'] != number:
            raise RuntimeError('Built app identity does not match the requested build.')
        check_artifact_policy(artifact)
        subprocess.run(['codesign', '--verify', '--deep', '--strict', str(artifact)], check=True)
        signed_entitlements = plistlib.loads(subprocess.check_output(
            ['codesign', '-d', '--entitlements', ':-', str(artifact)]))
        if signed_entitlements.get('aps-environment') != 'development':
            raise RuntimeError('Signed app is missing the expected APNs entitlement.')
        record.update(status='built', version=built['CFBundleShortVersionString'],
                      artifact=str(directory / artifact.name), finishedAt=now(),
                      privatePolicy={'liveActivities': False, 'pushNotifications': True,
                                     'notificationPreferences': NOTIFICATION_POLICY})
    except Exception as error:
        record.update(status='failed', error=str(error), finishedAt=now())
        raise
    finally:
        save(path, record)


def install(number):
    path = STATE / 'builds' / number / 'record.json'
    record = json.loads(path.read_text())
    if record['status'] != 'built':
        raise RuntimeError('Only a completed build can be installed.')
    if record.get('privatePolicy', {}).get('notificationPreferences') != NOTIFICATION_POLICY:
        raise RuntimeError('Build does not record the original attention-only notification policy.')
    check_artifact_policy(Path(record['artifact']))
    run('xcrun', 'devicectl', '--timeout', '120', 'device', 'install', 'app', '--device', DEVICE, record['artifact'])
    app = installed_app()
    if not app or app['bundleVersion'] != number or app['version'] != record['version']:
        raise RuntimeError('Device verification failed; installation ledger was not updated.')
    record.update(installedAt=now(), installedApp=app)
    save(STATE / 'installs' / (number + '.json'), record)
    save(STATE / 'installed.json', record)
    print('Verified installation:', record['version'], 'build', number)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['status', 'update', 'check', 'build', '_build', 'install'])
    parser.add_argument('number', nargs='?')
    parser.add_argument('--fetch', action='store_true')
    args = parser.parse_args()
    if args.command == 'status':
        status(args.fetch)
    elif args.command == 'update':
        update()
    elif args.command == 'check':
        check_source_policy()
        check_native_policy(SOURCE / 'apps/mobile/ios')
        print('Private iOS policy passed: attention alerts enabled, completion alerts and Live Activities disabled.')
    elif args.command == 'build':
        build()
    elif args.command == '_build':
        if not args.number or not args.number.isdigit():
            parser.error('_build requires a numeric build number')
        worker(args.number)
    else:
        if not args.number or not args.number.isdigit():
            parser.error('install requires a numeric build number')
        install(args.number)
