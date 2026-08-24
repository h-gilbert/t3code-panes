import { useLocation, useNavigate } from "@tanstack/react-router";
import { SearchIcon, XIcon } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import {
  AppearanceSettingsPanel,
  ArchivedThreadsPanel,
  GeneralSettingsPanel,
} from "./SettingsPanels";
import { KeybindingsSettingsPanel } from "./KeybindingsSettings";
import { ProviderSettingsPanel } from "./ProviderSettingsPanel";
import { IntegrationsSettingsPanel } from "./IntegrationsSettings";
import { SourceControlSettingsPanel } from "./SourceControlSettings";
import { ConnectionsSettings } from "./ConnectionsSettings";
import {
  SettingsAnchor,
  SettingsPageContainer,
  SettingsPageEmbedded,
  scrollToSettingsTarget,
} from "./settingsLayout";
import { searchSettings, SETTINGS_SECTION_LABELS, type SettingsSearchItem } from "./settingsSearch";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Kbd } from "../ui/kbd";

function SettingsPageSearch() {
  const navigate = useNavigate();
  const currentHash = useLocation({ select: (location) => location.hash });
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [activeResultIndex, setActiveResultIndex] = useState(0);
  const results = useMemo(() => searchSettings(query), [query]);
  const isSearching = query.trim().length > 0;

  const clearSearch = useCallback(() => {
    setQuery("");
    setActiveResultIndex(0);
  }, []);
  const selectResult = useCallback(
    (item: SettingsSearchItem) => {
      const targetId = item.targetId ?? item.id;
      clearSearch();
      if (currentHash.replace(/^#/, "") === targetId) {
        scrollToSettingsTarget(targetId);
        return;
      }
      void navigate({
        to: "/settings",
        hash: targetId,
        replace: true,
        resetScroll: false,
        hashScrollIntoView: false,
      });
    },
    [clearSearch, currentHash, navigate],
  );
  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Escape" && isSearching) {
        event.preventDefault();
        event.stopPropagation();
        clearSearch();
        return;
      }
      if (results.length === 0) return;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveResultIndex((index) => (index + 1) % results.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveResultIndex((index) => (index - 1 + results.length) % results.length);
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        const result = results[activeResultIndex];
        if (result) selectResult(result);
      }
    },
    [activeResultIndex, clearSearch, isSearching, results, selectResult],
  );

  useEffect(() => {
    const handleWindowKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable ||
          target.closest('[role="dialog"], [aria-modal="true"], [data-slot$="popup"]') !== null)
      ) {
        return;
      }
      event.preventDefault();
      inputRef.current?.focus();
    };
    window.addEventListener("keydown", handleWindowKeyDown);
    return () => window.removeEventListener("keydown", handleWindowKeyDown);
  }, []);

  return (
    <div className="relative z-20">
      <div className="flex h-10 items-center gap-2 rounded-xl border border-border bg-background px-3 shadow-xs focus-within:ring-2 focus-within:ring-ring">
        <SearchIcon className="size-4 shrink-0 text-muted-foreground" />
        <Input
          ref={inputRef}
          nativeInput
          unstyled
          type="search"
          value={query}
          onChange={(event) => {
            setQuery(event.currentTarget.value);
            setActiveResultIndex(0);
          }}
          onKeyDown={handleKeyDown}
          placeholder="Search settings"
          aria-label="Search settings"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={isSearching && results.length > 0}
          aria-controls={isSearching ? "settings-page-search-results" : undefined}
          aria-activedescendant={
            isSearching && results[activeResultIndex]
              ? `settings-page-search-result-${results[activeResultIndex].id}`
              : undefined
          }
          className="min-w-0 flex-1 [&_[data-slot=input]]:h-auto [&_[data-slot=input]]:p-0"
        />
        {isSearching ? (
          <Button
            type="button"
            size="icon-micro"
            variant="ghost-muted"
            aria-label="Clear settings search"
            onClick={() => {
              clearSearch();
              inputRef.current?.focus();
            }}
          >
            <XIcon className="size-3.5" />
          </Button>
        ) : (
          <Kbd>/</Kbd>
        )}
      </div>

      {isSearching ? (
        <div
          id="settings-page-search-results"
          role="listbox"
          aria-label="Settings search results"
          className="absolute inset-x-0 top-12 max-h-80 overflow-y-auto rounded-xl border border-border bg-popover p-1 shadow-lg"
        >
          {results.length > 0 ? (
            results.map((item, index) => (
              <button
                key={item.id}
                id={`settings-page-search-result-${item.id}`}
                type="button"
                role="option"
                aria-selected={index === activeResultIndex}
                className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left hover:bg-accent aria-selected:bg-accent"
                onMouseMove={() => setActiveResultIndex(index)}
                onClick={() => selectResult(item)}
              >
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{item.title}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {SETTINGS_SECTION_LABELS[item.to]}
                </span>
              </button>
            ))
          ) : (
            <p role="status" className="px-3 py-6 text-center text-sm text-muted-foreground">
              No settings found
            </p>
          )}
        </div>
      ) : null}
    </div>
  );
}

function SettingsPanelGroup({
  id,
  children,
}: {
  readonly id: string;
  readonly children: ReactNode;
}) {
  return (
    <SettingsAnchor id={id} className="border-b border-border/70 pb-12 last:border-b-0 last:pb-0">
      {children}
    </SettingsAnchor>
  );
}

export function AllSettingsPage() {
  return (
    <SettingsPageContainer width="expanded" className="gap-12">
      <SettingsPageSearch />
      <SettingsPageEmbedded>
        <SettingsPanelGroup id="settings-general">
          <GeneralSettingsPanel />
        </SettingsPanelGroup>
        <SettingsPanelGroup id="settings-appearance">
          <AppearanceSettingsPanel />
        </SettingsPanelGroup>
        <SettingsPanelGroup id="settings-keybindings">
          <KeybindingsSettingsPanel />
        </SettingsPanelGroup>
        <SettingsPanelGroup id="settings-providers">
          <ProviderSettingsPanel />
        </SettingsPanelGroup>
        <SettingsPanelGroup id="settings-integrations">
          <IntegrationsSettingsPanel />
        </SettingsPanelGroup>
        <SettingsPanelGroup id="settings-source-control">
          <SourceControlSettingsPanel />
        </SettingsPanelGroup>
        <SettingsPanelGroup id="settings-connections">
          <ConnectionsSettings />
        </SettingsPanelGroup>
        <SettingsPanelGroup id="settings-archive">
          <ArchivedThreadsPanel />
        </SettingsPanelGroup>
      </SettingsPageEmbedded>
    </SettingsPageContainer>
  );
}
