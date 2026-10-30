import { useEffect, useState } from "react";
import {
  DEFAULT_BROWSER_PROFILE_ID,
  resolveBrowserProfiles,
  type BrowserProfile,
  type DesktopBrowserCredentialSaveInput,
  type DesktopBrowserCredentialSummary,
} from "@t3tools/contracts";

import { useClientSettings } from "~/hooks/useSettings";
import { randomUUID } from "~/lib/utils";
import { useEnvironments, usePrimaryEnvironmentId } from "~/state/environments";
import { browserCredentialProfile } from "../preview/browserCredentialProfile";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsSection } from "./settingsLayout";

type CredentialStore = Pick<
  NonNullable<Window["desktopBridge"]>["preview"]["browserCredentials"],
  "list" | "save" | "delete"
>;

interface LoginDraft extends DesktopBrowserCredentialSaveInput {
  id: string;
  failed: boolean;
}

export function BrowserSavedLoginsManager({
  store,
  environments,
  profiles,
  initialEnvironmentId,
}: {
  readonly store: CredentialStore;
  readonly environments: ReadonlyArray<{ environmentId: string; label: string }>;
  readonly profiles: ReadonlyArray<BrowserProfile>;
  readonly initialEnvironmentId: string;
}) {
  const [environmentId, setEnvironmentId] = useState(initialEnvironmentId);
  const [profileId, setProfileId] = useState<string>(DEFAULT_BROWSER_PROFILE_ID);
  const [saved, setSaved] = useState<ReadonlyArray<DesktopBrowserCredentialSummary>>([]);
  const [drafts, setDrafts] = useState<ReadonlyArray<LoginDraft>>([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads credential metadata from the OS-backed store, without reading passwords
  useEffect(() => {
    let cancelled = false;
    void store.list().then(
      (entries) => {
        if (cancelled) return;
        setSaved(entries);
        setLoading(false);
        setMessage("");
      },
      () => {
        if (cancelled) return;
        setLoading(false);
        setMessage("Could not load saved logins. Try again.");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [store]);

  const scopeLabel = (
    entry: Pick<DesktopBrowserCredentialSummary, "environmentId" | "profile" | "profileId">,
  ) =>
    `${environments.find((environment) => environment.environmentId === entry.environmentId)?.label ?? "Unavailable environment"} · ${entry.profile ?? profiles.find((profile) => profile.id === (entry.profileId ?? DEFAULT_BROWSER_PROFILE_ID))?.name ?? "Unavailable profile"}`;

  const addDraft = () => {
    if (!environmentId) return;
    setDrafts((rows) => [
      ...rows,
      {
        id: randomUUID(),
        environmentId,
        ...browserCredentialProfile({ profileId }),
        url: "",
        username: "",
        password: "",
        failed: false,
      },
    ]);
  };
  const changeDraft = (id: string, field: "url" | "username" | "password", value: string) =>
    setDrafts((rows) =>
      rows.map((row) => (row.id === id ? { ...row, [field]: value, failed: false } : row)),
    );

  const saveAll = async () => {
    const pending = drafts.filter((row) => row.url || row.username || row.password);
    if (pending.length === 0) return;
    if (pending.some((row) => !row.url.trim() || !row.username.trim() || !row.password)) {
      setMessage("Enter a website, username and password for each login.");
      return;
    }
    const keys = new Set<string>();
    for (const row of pending) {
      let origin: string;
      try {
        origin = new URL(row.url.trim()).origin;
      } catch {
        setMessage("Enter a full website address, such as https://accounts.google.com.");
        return;
      }
      const key = JSON.stringify([
        row.environmentId,
        row.profile,
        row.profileId,
        origin,
        row.username.trim(),
      ]);
      if (keys.has(key)) {
        setMessage("Keep one password per website and username in each environment and profile.");
        return;
      }
      keys.add(key);
    }
    setBusy(true);
    const results = await Promise.all(
      pending.map(async (row) => {
        const { id, failed: _failed, ...input } = row;
        return store
          .save({ ...input, url: input.url.trim(), username: input.username.trim() })
          .then(
            (entry) => ({ id, entry }),
            () => ({ id, entry: null }),
          );
      }),
    );
    const successful = results.flatMap((result) => (result.entry ? [result.entry] : []));
    const completed = new Set(results.filter((result) => result.entry).map((result) => result.id));
    const failed = new Set(results.filter((result) => !result.entry).map((result) => result.id));
    setSaved((entries) => [
      ...entries.filter((entry) => !successful.some((next) => next.id === entry.id)),
      ...successful,
    ]);
    setDrafts((rows) =>
      rows
        .filter((row) => !completed.has(row.id))
        .map((row) => ({ ...row, failed: failed.has(row.id) })),
    );
    setMessage(
      failed.size
        ? "Some logins could not be saved. Check their website addresses and try again."
        : `Saved ${successful.length} login${successful.length === 1 ? "" : "s"}.`,
    );
    setBusy(false);
  };

  const refresh = async () => {
    setLoading(true);
    const entries = await store.list().then(
      (value) => value,
      () => null,
    );
    if (entries) setSaved(entries);
    setMessage(entries ? "" : "Could not load saved logins. Try again.");
    setLoading(false);
  };

  const removeSaved = async (id: string) => {
    setBusy(true);
    const removed = await store.delete(id).then(
      () => true,
      () => false,
    );
    if (removed) setSaved((entries) => entries.filter((entry) => entry.id !== id));
    setMessage(removed ? "Login removed." : "Could not remove the login. Try again.");
    setBusy(false);
  };

  return (
    <div className="space-y-4 p-3 sm:p-4">
      <p className="text-sm text-muted-foreground">
        Passwords are encrypted on this computer. Agents can fill them without seeing them. Changes
        here do not sign you out of websites.
      </p>
      <p className="text-sm text-muted-foreground">
        Use each site's sign-in address, such as https://accounts.google.com for Google.
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">New logins available to</p>
          <Select
            value={environmentId}
            onValueChange={(value) => {
              if (value) setEnvironmentId(value);
            }}
            disabled={busy}
          >
            <SelectTrigger aria-label="Environment for new logins">
              <SelectValue>
                {environments.find((environment) => environment.environmentId === environmentId)
                  ?.label ?? "Choose environment"}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {environments.map((environment) => (
                <SelectItem key={environment.environmentId} value={environment.environmentId}>
                  {environment.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">Browser profile</p>
          <Select
            value={profileId}
            onValueChange={(value) => {
              if (value) setProfileId(value);
            }}
            disabled={busy}
          >
            <SelectTrigger aria-label="Profile for new logins">
              <SelectValue>
                {profiles.find((profile) => profile.id === profileId)?.name ?? "Choose profile"}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {profiles
                .filter((profile) => profile.kind === "persistent")
                .map((profile) => (
                  <SelectItem key={profile.id} value={profile.id}>
                    {profile.name}
                  </SelectItem>
                ))}
            </SelectPopup>
          </Select>
        </div>
        <Button variant="outline" onClick={addDraft} disabled={busy || loading || !environmentId}>
          Add login
        </Button>
      </div>
      {drafts.length > 0 && (
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            void saveAll();
          }}
        >
          {drafts.map((row, index) => (
            <fieldset key={row.id} disabled={busy} className="space-y-2 rounded-md border p-3">
              <legend className="px-1 text-xs text-muted-foreground">
                Login {index + 1} · {scopeLabel(row)}
              </legend>
              <div className="grid gap-2 sm:grid-cols-3">
                <Input
                  aria-label={`Website ${index + 1}`}
                  placeholder="https://accounts.google.com"
                  value={row.url}
                  disabled={saved.some((entry) => entry.id === row.id)}
                  autoComplete="off"
                  onChange={(event) => changeDraft(row.id, "url", event.target.value)}
                />
                <Input
                  aria-label={`Username ${index + 1}`}
                  placeholder="Username or email"
                  value={row.username}
                  disabled={saved.some((entry) => entry.id === row.id)}
                  autoComplete="off"
                  onChange={(event) => changeDraft(row.id, "username", event.target.value)}
                />
                <Input
                  aria-label={`Password ${index + 1}`}
                  placeholder="Password"
                  type="password"
                  autoComplete="new-password"
                  value={row.password}
                  onChange={(event) => changeDraft(row.id, "password", event.target.value)}
                />
              </div>
              <div className="flex items-center justify-between gap-2">
                {row.failed ? (
                  <p role="alert" className="text-xs text-error">
                    Could not save this login.
                  </p>
                ) : (
                  <span />
                )}
                <Button
                  size="xs"
                  variant="ghost"
                  type="button"
                  onClick={() => setDrafts((rows) => rows.filter((draft) => draft.id !== row.id))}
                >
                  Discard login {index + 1}
                </Button>
              </div>
            </fieldset>
          ))}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={busy || loading}>
              {busy ? "Saving…" : "Save all logins"}
            </Button>
            <Button type="button" variant="outline" disabled={busy || loading} onClick={addDraft}>
              Add another login
            </Button>
            <Button type="button" variant="outline" disabled={busy} onClick={() => setDrafts([])}>
              Discard unsaved logins
            </Button>
          </div>
        </form>
      )}
      {message && (
        <p role="status" className="text-sm">
          {message}
        </p>
      )}
      {loading ? (
        <p className="text-sm text-muted-foreground">Loading saved logins…</p>
      ) : (
        <>
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-medium">Saved logins ({saved.length})</h3>
            <Button variant="ghost" size="xs" disabled={busy} onClick={() => void refresh()}>
              Refresh
            </Button>
          </div>
          {saved.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No logins saved yet. Add several above, then save them together.
            </p>
          ) : (
            saved
              .toSorted(
                (a, b) => a.origin.localeCompare(b.origin) || a.username.localeCompare(b.username),
              )
              .map((entry) => (
                <div
                  key={entry.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3"
                >
                  <div className="min-w-0">
                    <p className="break-all text-sm font-medium">{entry.origin}</p>
                    <p className="break-all text-sm">{entry.username}</p>
                    <p className="text-xs text-muted-foreground">{scopeLabel(entry)}</p>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="xs"
                      disabled={
                        busy ||
                        entry.environmentId === null ||
                        drafts.some((row) => row.id === entry.id)
                      }
                      onClick={() =>
                        setDrafts((rows) => [
                          ...rows,
                          {
                            id: entry.id,
                            environmentId: entry.environmentId!,
                            url: entry.origin,
                            username: entry.username,
                            profile: entry.profile,
                            ...(entry.profileId ? { profileId: entry.profileId } : {}),
                            password: "",
                            failed: false,
                          },
                        ])
                      }
                    >
                      Replace password
                    </Button>
                    <Button
                      variant="ghost"
                      size="xs"
                      disabled={busy}
                      onClick={() => void removeSaved(entry.id)}
                    >
                      Remove
                    </Button>
                  </div>
                </div>
              ))
          )}
        </>
      )}
    </div>
  );
}

export function BrowserSavedLoginsSetting() {
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const profiles = resolveBrowserProfiles(
    useClientSettings((settings) => settings.browserProfiles),
  );
  const store = window.desktopBridge?.preview?.browserCredentials;
  return (
    <SettingsSection id="browser-saved-logins" title="Saved logins">
      {store ? (
        <BrowserSavedLoginsManager
          store={store}
          environments={environments}
          profiles={profiles}
          initialEnvironmentId={primaryEnvironmentId ?? environments[0]?.environmentId ?? ""}
        />
      ) : (
        <p className="p-4 text-sm text-muted-foreground">
          Open Browser settings in the desktop app to manage encrypted logins.
        </p>
      )}
    </SettingsSection>
  );
}
