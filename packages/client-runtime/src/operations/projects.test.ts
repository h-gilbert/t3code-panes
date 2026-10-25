import { SourceControlProviderKind, EnvironmentId, ProjectId, CommandId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  findExistingAddProject,
  getCloneDirectoryName,
  getDefaultCloneUrl,
  normalizePastedCloneUrl,
  buildProjectCreateCommand,
  getNewProjectPublishTarget,
  getNewProjectPublishTargets,
} from "./projects.ts";
import type { EnvironmentProject } from "../state/models.ts";

import * as Option from "effect/Option";

describe("add project shared logic", () => {
  it("routes owner/repository shorthand to GitHub over HTTPS", () => {
    expect(normalizePastedCloneUrl("imputnet/helium")).toBe(
      "https://github.com/imputnet/helium.git",
    );
    expect(normalizePastedCloneUrl("  pingdotgg/t3code  ")).toBe(
      "https://github.com/pingdotgg/t3code.git",
    );
  });

  it("keeps explicit clone URLs and local paths unchanged", () => {
    expect(normalizePastedCloneUrl("https://gitlab.com/group/project.git")).toBe(
      "https://gitlab.com/group/project.git",
    );
    expect(normalizePastedCloneUrl("git@github.com:owner/repo.git")).toBe(
      "git@github.com:owner/repo.git",
    );
    expect(normalizePastedCloneUrl("group/subgroup/project")).toBe("group/subgroup/project");
    expect(normalizePastedCloneUrl("/srv/git/repo.git")).toBe("/srv/git/repo.git");
  });

  it("uses HTTPS for repositories selected through a provider", () => {
    expect(
      getDefaultCloneUrl({
        provider: SourceControlProviderKind.make("github"),
        url: "https://github.com/imputnet/helium",
        sshUrl: "git@github.com:imputnet/helium.git",
      }),
    ).toBe("https://github.com/imputnet/helium");
    expect(
      getDefaultCloneUrl({
        provider: SourceControlProviderKind.make("forgejo"),
        url: "https://forgejo.example.test:8443/owner/repo.git",
        sshUrl: "ssh://git@forgejo.example.test:2222/owner/repo.git",
      }),
    ).toBe("https://forgejo.example.test:8443/owner/repo.git");
  });

  it("derives the clone folder name from any pasted clone URL", () => {
    expect(getCloneDirectoryName("https://github.com/owner/repo.git")).toBe("repo");
    expect(getCloneDirectoryName("https://github.com/owner/repo")).toBe("repo");
    expect(getCloneDirectoryName("https://github.com/owner/repo/")).toBe("repo");
    expect(getCloneDirectoryName("git@github.com:owner/repo.git")).toBe("repo");
    expect(getCloneDirectoryName("ssh://git@github.com:22/owner/repo.git")).toBe("repo");
    expect(getCloneDirectoryName("https://user@bitbucket.org/owner/repo.git")).toBe("repo");
    expect(getCloneDirectoryName("https://dev.azure.com/org/project/_git/repo")).toBe("repo");
    expect(getCloneDirectoryName("https://github.com/owner/repo.git?ref=main#readme")).toBe("repo");
    expect(getCloneDirectoryName("/srv/git/repo.git")).toBe("repo");
    expect(getCloneDirectoryName("C:\\src\\repo.git")).toBe("repo");
    expect(getCloneDirectoryName("git@github.com:repo.git")).toBe("repo");
    expect(getCloneDirectoryName("  https://github.com/owner/repo.git  ")).toBe("repo");
  });

  it("keeps a numeric repository name that sits on a path", () => {
    expect(getCloneDirectoryName("https://github.com/acme/123.git")).toBe("123");
    expect(getCloneDirectoryName("https://github.com/acme/123")).toBe("123");
    expect(getCloneDirectoryName("git@github.com:acme/123.git")).toBe("123");
  });

  it("finds existing projects by normalized path in the target environment", () => {
    const env = EnvironmentId.make("env");
    const other = EnvironmentId.make("other");
    const projects: EnvironmentProject[] = [
      {
        environmentId: other,
        id: ProjectId.make("same-path-other-env"),
        title: "Other",
        workspaceRoot: "/repo",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        repositoryIdentity: null,
        defaultModelSelection: null,
        scripts: [],
      },
      {
        environmentId: env,
        id: ProjectId.make("project"),
        title: "Repo",
        workspaceRoot: "/repo/",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        repositoryIdentity: null,
        defaultModelSelection: null,
        scripts: [],
      },
    ];

    expect(findExistingAddProject({ projects, environmentId: env, path: "/repo" })?.id).toBe(
      "project",
    );
  });

  it("builds the V2 project.create mutation", () => {
    expect(
      buildProjectCreateCommand({
        commandId: CommandId.make("command"),
        projectId: ProjectId.make("project"),
        workspaceRoot: "/work/repo",
      }),
    ).toMatchObject({
      type: "project.create",
      commandId: "command",
      projectId: "project",
      title: "repo",
      workspaceRoot: "/work/repo",
      createWorkspaceRootIfMissing: true,
      defaultModelSelection: {
        instanceId: "claudeAgent",
        model: "claude-opus-4-8",
        options: [{ id: "effort", value: "medium" }],
      },
    });
  });
});

describe("new project publish targets", () => {
  const readyHost = (kind: string, account: string | null) => ({
    kind: SourceControlProviderKind.make(kind),
    label: kind,
    status: "available" as const,
    installHint: "",
    version: Option.none(),
    detail: Option.none(),
    auth: {
      status: "authenticated" as const,
      account: Option.fromNullOr(account),
      host: Option.none(),
      detail: Option.none(),
    },
  });

  it("offers ready hosts that can place the repository, GitHub first, and keeps the pick", () => {
    const targets = getNewProjectPublishTargets({
      versionControlSystems: [],
      sourceControlProviders: [
        readyHost("gitlab", "group"),
        readyHost("github", null),
        readyHost("azure-devops", "me"),
      ],
    });
    expect(targets.map((target) => target.definition.kind)).toEqual(["github", "gitlab"]);
    expect(getNewProjectPublishTarget(targets, null)?.definition.kind).toBe("github");
    expect(
      getNewProjectPublishTarget(targets, SourceControlProviderKind.make("gitlab"))?.owner,
    ).toBe("group");
  });
});
