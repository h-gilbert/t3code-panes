import importlib.util
import json
import plistlib
from pathlib import Path
import tempfile
import unittest
import sys
from unittest.mock import patch

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('ios_local', Path(__file__).with_name('ios-local.py'))
ios = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ios)


class InstallLedgerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.state = Path(self.temporary.name)
        self.addCleanup(patch.stopall)
        patch.object(ios, 'STATE', self.state).start()
        artifact = self.state / 'T3CodeSelfHosted.app'
        artifact.mkdir()
        (artifact / 'Info.plist').write_bytes(plistlib.dumps({}))
        self.record = {'status': 'built', 'buildNumber': '2', 'version': '1.0.4',
                       'artifact': str(artifact),
                       'privatePolicy': {'notificationPreferences': dict(ios.NOTIFICATION_POLICY)}}
        ios.save(self.state / 'builds/2/record.json', self.record)

    def test_failed_install_preserves_previous_record(self):
        previous = {'buildNumber': '1'}
        ios.save(self.state / 'installed.json', previous)
        with patch.object(ios, 'run', side_effect=RuntimeError('device unavailable')):
            with self.assertRaises(RuntimeError):
                ios.install('2')
        self.assertEqual(json.loads((self.state / 'installed.json').read_text()), previous)

    def test_wrong_device_version_does_not_record_success(self):
        with patch.object(ios, 'run'), patch.object(ios, 'installed_app', return_value={
            'bundleVersion': '1', 'version': '1.0.4',
        }):
            with self.assertRaises(RuntimeError):
                ios.install('2')
        self.assertFalse((self.state / 'installed.json').exists())

    def test_verified_install_records_history_and_current(self):
        app = {'bundleVersion': '2', 'version': '1.0.4'}
        with patch.object(ios, 'run'), patch.object(ios, 'installed_app', return_value=app):
            ios.install('2')
        current = json.loads((self.state / 'installed.json').read_text())
        self.assertEqual(current['installedApp'], app)
        self.assertIn('installedAt', current)
        self.assertEqual(current, json.loads((self.state / 'installs/2.json').read_text()))

    def test_failed_build_cannot_be_installed(self):
        self.record['status'] = 'failed'
        ios.save(self.state / 'builds/2/record.json', self.record)
        with patch.object(ios, 'run') as run:
            with self.assertRaises(RuntimeError):
                ios.install('2')
            run.assert_not_called()

    def test_old_completion_alert_policy_cannot_be_installed(self):
        self.record['privatePolicy']['notificationPreferences']['notifyOnCompletion'] = True
        ios.save(self.state / 'builds/2/record.json', self.record)
        with patch.object(ios, 'run') as run:
            with self.assertRaisesRegex(RuntimeError, 'iOS-origin'):
                ios.install('2')
            run.assert_not_called()

    def test_live_activity_build_cannot_be_installed(self):
        (Path(self.record['artifact']) / 'Info.plist').write_bytes(
            plistlib.dumps({'NSSupportsLiveActivities': True}))
        with patch.object(ios, 'run') as run:
            with self.assertRaisesRegex(RuntimeError, 'Live Activities'):
                ios.install('2')
            run.assert_not_called()

    def test_widget_extension_cannot_be_installed(self):
        extension = Path(self.record['artifact']) / 'PlugIns/RenamedActivity.appex'
        extension.mkdir(parents=True)
        (extension / 'Info.plist').write_bytes(plistlib.dumps({'NSExtension': {
            'NSExtensionPointIdentifier': 'com.apple.widgetkit-extension',
        }}))
        with patch.object(ios, 'run') as run:
            with self.assertRaisesRegex(RuntimeError, 'extension'):
                ios.install('2')
            run.assert_not_called()


class PrivateSourcePolicyTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.source = Path(self.temporary.name)
        self.mobile = self.source / 'apps/mobile'
        self.payload = self.mobile / 'src/features/agent-awareness/registrationPayload.ts'
        self.payload.parent.mkdir(parents=True)
        self.payload.write_text('const preferences = {liveActivitiesEnabled: false,\n'
                                'notifyOnApproval: true, notifyOnInput: true,\n'
                                'notifyOnCompletion: false, notifyOnIosCompletion: true, notifyOnFailure: true};')
        (self.mobile / 'app.config.ts').write_text('')
        (self.mobile / 'package.json').write_text(json.dumps({
            'dependencies': {'expo-notifications': '57'},
        }))

    def test_push_only_source_is_accepted(self):
        ios.check_source_policy(self.source)

    def test_upstream_live_preference_change_is_rejected(self):
        self.payload.write_text('const preferences = {liveActivitiesEnabled: enabled};')
        with self.assertRaises(RuntimeError):
            ios.check_source_policy(self.source)

    def test_completion_alerts_cannot_be_reenabled(self):
        self.payload.write_text(self.payload.read_text().replace(
            'notifyOnCompletion: false', 'notifyOnCompletion: true'))
        with self.assertRaisesRegex(RuntimeError, 'notifyOnCompletion'):
            ios.check_source_policy(self.source)

    def test_ios_completion_filter_must_stay_enabled(self):
        self.payload.write_text(self.payload.read_text().replace(
            "notifyOnIosCompletion: true", "notifyOnIosCompletion: false"))
        with self.assertRaisesRegex(RuntimeError, "notifyOnIosCompletion"):
            ios.check_source_policy(self.source)

    def test_attention_alerts_cannot_be_disabled(self):
        for preference in ['notifyOnApproval', 'notifyOnInput', 'notifyOnFailure']:
            with self.subTest(preference=preference):
                original = self.payload.read_text()
                self.payload.write_text(original.replace(preference + ': true', preference + ': false'))
                with self.assertRaisesRegex(RuntimeError, preference):
                    ios.check_source_policy(self.source)
                self.payload.write_text(original)

    def test_missing_push_dependency_is_rejected(self):
        (self.mobile / 'package.json').write_text('{"dependencies": {}}')
        with self.assertRaises(RuntimeError):
            ios.check_source_policy(self.source)

    def test_new_native_activity_code_is_rejected(self):
        native = self.mobile / 'modules/new-controls/ios'
        native.mkdir(parents=True)
        (native / 'NewControls.swift').write_text('import ActivityKit')
        with self.assertRaises(RuntimeError):
            ios.check_source_policy(self.source)





class StableUpdateTests(unittest.TestCase):
    def test_unreleased_refs_are_rejected_before_fetch_or_merge(self):
        for tag in ['main', 'upstream/main', 'v0.0.46-nightly', 'deadbeef']:
            with self.subTest(tag=tag), patch.object(ios, 'run') as run:
                with self.assertRaises(RuntimeError):
                    ios.stable_target(fetch=True, tag=tag)
                run.assert_not_called()

    def test_release_discovery_rejects_prereleases(self):
        with patch.object(ios, 'run', return_value=json.dumps({'tag_name': 'v0.0.46', 'prerelease': True})):
            with self.assertRaises(RuntimeError):
                ios.stable_target(fetch=True)

    def test_update_merges_the_pinned_commit_and_preserves_private_branch(self):
        with patch.object(ios, 'run', return_value=''), patch.object(ios, 'stable_target', return_value={'tag': 'v0.0.45', 'revision': 'stable-sha'}), patch.object(ios, 'save'), patch.object(ios.subprocess, 'run') as merge, patch.object(ios, 'check_source_policy') as policy:
            ios.update('v0.0.45')
            merge.assert_called_once_with(['git', 'merge', '--no-edit', 'stable-sha'], cwd=ios.SOURCE, check=True)
            policy.assert_called_once_with()

if __name__ == '__main__':
    unittest.main()
