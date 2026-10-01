import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { usesFastProcessing } from "../src/executionPresentation.js";
import {
  dashboardHistoryActivityHeading,
  dashboardHistoryActivityIdentity,
  dashboardExecutionsEqual,
  dispatchDashboardExternalUrl,
  DASHBOARD_CARD_CONTENT_METADATA,
  DASHBOARD_CARD_HTML,
  DASHBOARD_CARD_HTML_MAX_BYTES,
  groupDashboardRowsByActivity,
  shouldShowDashboardNextExecution
} from "../src/dashboardCard.js";
import { PRODUCT_INFO } from "../src/productInfo.js";
import { htmlForUiResource } from "../src/uiResources.js";
import {
  SETTINGS_CARD_CONTENT_METADATA,
  SETTINGS_CARD_HTML,
  SETTINGS_CARD_HTML_MAX_BYTES,
  uiBridgeErrorMessage
} from "../src/settingsCard.js";
import {
  isUiLocalePreference,
  localizeSettingsWarning,
  missingReasoningEffortTranslations,
  reasoningEffortPresentation,
  resolveHostUiLocaleTag,
  resolvePreferredUiLocale,
  resolveUiLocale,
  serializedUiTranslations,
  SUPPORTED_UI_LOCALES,
  UI_LOCALE_PREFERENCES,
  UI_TRANSLATIONS,
  uiTranslation
} from "../src/uiI18n.js";

const PROJECT_TRANSLATION_KEYS = [
  "settings.projects",
  "settings.projectsHint",
  "settings.allowedRoots",
  "settings.allowedRootsHint",
  "settings.addProject",
  "settings.addFirstProject",
  "settings.noProjects",
  "settings.projectLabel",
  "settings.projectCwd",
  "settings.projectAvailable",
  "settings.projectUnavailable",
  "settings.projectNew",
  "settings.archiveProject",
  "settings.restoreProject",
  "settings.deleteProject",
  "settings.cancelDeleteProject",
  "settings.deleteProjectConfirm",
  "settings.projectArchived",
  "settings.projectArchivePending",
  "settings.projectRestorePending",
  "settings.projectDeletePending",
  "settings.projectInvalidLabel",
  "settings.projectInvalidCwd",
  "settings.projectDuplicatePath",
  "settings.projectUnavailableSave",
  "settings.projectLimit",
  "settings.projectError"
] as const;

describe("human-facing UI localization", () => {
  it("materializes every native key in every generated language, including the source language", () => {
    const native = JSON.parse(readFileSync("macos/Resources/Localization/Localizable.xcstrings", "utf8"));
    for (const [key, entry] of Object.entries(native.strings) as Array<[string, {
      localizations: Record<string, { stringUnit?: { state?: string; value?: string } }>;
    }]>) {
      for (const locale of SUPPORTED_UI_LOCALES) {
        const unit = entry.localizations[locale]?.stringUnit;
        expect(unit?.state, `${locale}:${key}`).toBe("translated");
        expect(unit?.value?.trim(), `${locale}:${key}`).toBeTruthy();
      }
    }
  });

  it("uses the same shared semantic-key copy in the card and native app for every locale", () => {
    const native = JSON.parse(readFileSync("macos/Resources/Localization/Localizable.xcstrings", "utf8"));
    const ultraKeys = ["settings.ultraNoSelection", "settings.ultraFixedConflict"] as const;
    for (const locale of SUPPORTED_UI_LOCALES) {
      const bundle = UI_TRANSLATIONS[locale];
      for (const [key, value] of Object.entries(bundle)) {
        expect(native.strings[key]?.localizations[locale]?.stringUnit?.value, `${locale}:${key}`)
          .toBe(value);
      }
      for (const key of ultraKeys) {
        const value = bundle[key];
        expect(UI_TRANSLATIONS[locale as keyof typeof UI_TRANSLATIONS][key as keyof typeof bundle]).toBe(value);
        expect(native.strings[key].localizations[locale].stringUnit.value).toBe(value);
      }
      expect(localizeSettingsWarning(
        "Ultra is disabled and no saved model and reasoning choice can currently run.",
        locale as keyof typeof UI_TRANSLATIONS
      )).toBe(bundle["settings.ultraNoSelection"]);
    }
  });

  it("ships complete, shared bundles for every supported locale", () => {
    expect(SUPPORTED_UI_LOCALES).toEqual([
      "en",
      "ko",
      "ja",
      "zh-Hans",
      "zh-Hant",
      "es",
      "fr",
      "de",
      "pt"
    ]);
    const englishKeys = Object.keys(UI_TRANSLATIONS.en).sort();
    for (const locale of SUPPORTED_UI_LOCALES) {
      expect(Object.keys(UI_TRANSLATIONS[locale]).sort()).toEqual(englishKeys);
      for (const value of Object.values(UI_TRANSLATIONS[locale])) {
        expect(value.trim().length).toBeGreaterThan(0);
      }
    }
    for (const locale of SUPPORTED_UI_LOCALES.filter((entry) => entry !== "en")) {
      expect(UI_TRANSLATIONS[locale]["common.loading"]).not.toBe(UI_TRANSLATIONS.en["common.loading"]);
      expect(UI_TRANSLATIONS[locale]["settings.language"]).not.toBe(UI_TRANSLATIONS.en["settings.language"]);
      for (const key of [
        "settings.codexAppThreads",
        "settings.codexAppThreadsHint"
      ] as const) {
        expect(UI_TRANSLATIONS[locale][key]).not.toBe(UI_TRANSLATIONS.en[key]);
      }
      expect(UI_TRANSLATIONS[locale]["settings.conflict"]).not.toBe(
        UI_TRANSLATIONS.en["settings.conflict"]
      );
      for (const key of PROJECT_TRANSLATION_KEYS) {
        expect(UI_TRANSLATIONS[locale][key]).not.toBe(UI_TRANSLATIONS.en[key]);
      }
      for (const key of ["dashboard.scope.label", "dashboard.scope.conversation", "dashboard.scope.all",
        "dashboard.scope.conversationNotice", "dashboard.scope.allNotice", "dashboard.scope.unavailable",
        "dashboard.scope.runtimeNotice"] as const) {
        expect(UI_TRANSLATIONS[locale][key]).not.toBe(UI_TRANSLATIONS.en[key]);
      }
      expect(UI_TRANSLATIONS[locale]["job.interrupted"]).not.toBe(UI_TRANSLATIONS.en["job.interrupted"]);
      expect(UI_TRANSLATIONS[locale]["waiting.orchestrator"]).not.toBe(UI_TRANSLATIONS.en["waiting.orchestrator"]);
    }

    const settingsText = SUPPORTED_UI_LOCALES.flatMap((locale) =>
      Object.entries(UI_TRANSLATIONS[locale])
        .filter(([key]) => key.startsWith("settings."))
        .map(([, value]) => value)
    ).join("\n");
    expect(settingsText).not.toMatch(/\boperator\b|운영자|管理者|管理员|管理員|operador|opérateur|Betreiber/i);
    expect(UI_TRANSLATIONS.ko["settings.reset"]).toBe("일반 설정 기본값 복원");
    expect(UI_TRANSLATIONS.ko["settings.resetHint"]).toContain("프로젝트와 순서는 유지");
    expect(UI_TRANSLATIONS.ko["settings.fullWarning"]).toBe(
      "전체 접근은 이 macOS 사용자의 파일시스템·네트워크 권한으로 Codex를 실행합니다. 프로젝트 폴더는 작업 시작 위치를 정할 뿐 OS 격리가 아닙니다."
    );
    expect(UI_TRANSLATIONS.ko["activity.currentExecution"]).toBe("현재 실행");
    expect(UI_TRANSLATIONS.ko["activity.latestExecution"]).toBe("최근 실행");
    expect(UI_TRANSLATIONS.ko["activity.reasoningEffort"]).toBe("에포트");
    expect(UI_TRANSLATIONS.ko["activity.workComplete"]).toBe("작업 완료");
    expect(UI_TRANSLATIONS.ko["dashboard.title"]).toBe("Codex 현황");
    expect(UI_TRANSLATIONS.ko["dashboard.scope.conversation"]).toBe("이 대화");
    expect(UI_TRANSLATIONS.ko["dashboard.scope.all"]).toBe("전체 현황");
    expect(UI_TRANSLATIONS.ko["dashboard.restoreFailed"]).toContain("새로고침");
    expect(UI_TRANSLATIONS.ko["dashboard.status.completed"]).toBe("Codex turn 완료");
    expect(UI_TRANSLATIONS.ko["dashboard.status.background-process-running"])
      .toBe("백그라운드 프로세스 실행 중");
    expect(UI_TRANSLATIONS.ko["dashboard.history.show"]).toBe("이력 {count}건 펼치기");
    expect(UI_TRANSLATIONS.ko["dashboard.openConversation"]).toBe("대화 열기");
    expect(UI_TRANSLATIONS.ko["dashboard.attention"]).toBe("주의 상태");
    expect(UI_TRANSLATIONS.ko["dashboard.loadMore"]).toBe("더 보기");
    expect(UI_TRANSLATIONS.en["dashboard.loadMore"]).toBe("Show more");
    expect(UI_TRANSLATIONS.ko["dashboard.view.project"]).toBe("프로젝트별");
    expect(UI_TRANSLATIONS.ko["dashboard.view.conversation"]).toBe("대화별");
    expect(UI_TRANSLATIONS.ko["dashboard.view.status"]).toBe("상태별");
    expect(UI_TRANSLATIONS.ko["dashboard.conversationCurrent"])
      .toBe("활성 및 최근 GPT 대화");
    expect(UI_TRANSLATIONS.ko["dashboard.idleConversations"]).toBe("유휴 GPT 대화");
    expect(UI_TRANSLATIONS.ko["dashboard.idleProjects"]).toBe("유휴 프로젝트");
    expect(UI_TRANSLATIONS.ko["dashboard.unknownProject"]).toBe("프로젝트 미확인");
    expect(UI_TRANSLATIONS.ko["settings.deleteProject"]).toBe("삭제");
    expect(UI_TRANSLATIONS.ko["settings.deleteProjectConfirm"])
      .toContain("실제 폴더와 파일");
    expect(UI_TRANSLATIONS.ko["settings.deleteProjectConfirm"])
      .toContain("저장 버튼을 누르면");
    expect(UI_TRANSLATIONS.ko["settings.projectDeletePending"])
      .toBe("저장 버튼을 누르면 이 프로젝트 등록이 삭제됩니다.");
    expect(UI_TRANSLATIONS.ko["dashboard.idleAgentDisclosure"])
      .toBe("유휴 에이전트 {count}개 펼치기");
    expect(UI_TRANSLATIONS.ko["dashboard.agentShownCount"]).toBe("현재 페이지 {count}개");
    expect(UI_TRANSLATIONS.ko["dashboard.sectionCount"])
      .toBe("대화 {conversations}개 · 에이전트 {agents}개");
    expect(UI_TRANSLATIONS.ko["dashboard.time.duration"]).toBe("작업시간 {duration}");
    expect(UI_TRANSLATIONS.ko["dashboard.time.terminal"]).toBe("{relative}");
    expect(UI_TRANSLATIONS.ko["dashboard.scopeNotice"]).toContain("전체 ChatGPT 기록은 아닙니다");
    expect(UI_TRANSLATIONS.ko["dashboard.runtimeOnly"]).toContain("GPT의 검증·완료 판단은 사용하지 않습니다");
    for (const locale of SUPPORTED_UI_LOCALES) {
      expect(UI_TRANSLATIONS[locale]["waiting.orchestrator"]).toBe(
        UI_TRANSLATIONS[locale]["activity.workComplete"]
      );
    }
    expect(UI_TRANSLATIONS.ko["settings.allowedScope.catalog"]).toBe(
      "사용 가능한 모든 모델·에포트"
    );
    expect(UI_TRANSLATIONS.ko["settings.allowedScope.explicit"]).toBe(
      "직접 선택한 모델·에포트만"
    );
    expect(UI_TRANSLATIONS.ko["settings.preferredModel"]).toBe("GPT 미지정 시 기본 모델");
    expect(UI_TRANSLATIONS.ko["settings.preferredEffort"]).toBe("GPT 미지정 시 기본 추론 수준");
    expect(UI_TRANSLATIONS.ko).not.toHaveProperty("settings.orchestrationDefaults");
    expect(UI_TRANSLATIONS.ko).not.toHaveProperty("settings.orchestrationDefaultsHint");
    expect(UI_TRANSLATIONS.ko["settings.codexAppThreads"]).toBe(
      "브리지 스레드를 Codex 앱에 표시"
    );
    expect(UI_TRANSLATIONS.ko["settings.codexAppThreadsHint"]).toContain(
      "Codex 앱 목록에 나타나지 않으며"
    );
    expect(UI_TRANSLATIONS.ko["settings.experimental.directResults"])
      .toBe("Codex 결과 직접 수신");
    expect(UI_TRANSLATIONS.ko["settings.experimental.directResultsHint"])
      .toContain("자동 연속 진행은 보장되지 않습니다");
    expect(UI_TRANSLATIONS.ko["settings.developerModeRefreshRequired"]).toContain(
      "정적 도구 계약도 변경"
    );
  });

  it("supports automatic host language and fixed saved language preferences", () => {
    expect(UI_LOCALE_PREFERENCES).toEqual([
      "auto", "en", "ko", "ja", "zh-Hans", "zh-Hant", "es", "fr", "de", "pt"
    ]);
    expect(isUiLocalePreference("auto")).toBe(true);
    expect(isUiLocalePreference("ko")).toBe(true);
    expect(isUiLocalePreference("it")).toBe(false);
    expect(resolvePreferredUiLocale("auto", "ko-KR")).toBe("ko");
    expect(resolvePreferredUiLocale("ja", "ko-KR")).toBe("ja");
    for (const preference of UI_LOCALE_PREFERENCES.filter((entry) => entry !== "auto")) {
      expect(resolvePreferredUiLocale(preference, "en-US")).toBe(preference);
    }
  });

  it("localizes audited settings warnings without exposing raw English diagnostics", () => {
    expect(localizeSettingsWarning(
      "CODEX_MCP_BRIDGE_ROOTS is a legacy compatibility restriction.",
      "ko"
    )).toBe(UI_TRANSLATIONS.ko["settings.warning.legacyRoots"]);
    expect(localizeSettingsWarning(
      'PROJECT_UNAVAILABLE: Saved project "샘플" is unavailable and cannot admit new work.',
      "ko"
    )).toBe("저장된 프로젝트 ‘샘플’을(를) 사용할 수 없어 새 작업을 받을 수 없습니다.");
    expect(localizeSettingsWarning("upstream socket detail", "ko", {
      catalog: true,
      stale: true
    })).toBe(UI_TRANSLATIONS.ko["settings.warning.catalogStale"]);
    expect(localizeSettingsWarning("unrecognized upstream prose", "ja"))
      .toBe(UI_TRANSLATIONS.ja["settings.warning.generic"]);
    expect(uiTranslation("de", "common.errorCode", { code: "MODEL_UNAVAILABLE" }))
      .toContain("MODEL_UNAVAILABLE");
  });

  it("keeps audited UI text translated and preserves every template placeholder", () => {
    const allowedSameAsEnglish = new Set([
      "activity.defaultAgent",
      "activity.threads",
      "dashboard.page",
      "dashboard.conversationCount",
      "dashboard.time.terminal"
    ]);
    for (const locale of SUPPORTED_UI_LOCALES.filter((entry) => entry !== "en")) {
      for (const key of Object.keys(UI_TRANSLATIONS.en) as Array<keyof typeof UI_TRANSLATIONS.en>) {
        const audited = key.startsWith("settings.warning.") ||
          key.startsWith("dashboard.") ||
          key.startsWith("activity.prompt.") ||
          [
            "settings.modelPolicy",
            "settings.modelPolicy.fixed",
            "settings.modelPolicy.automatic",
            "settings.allowDelegation",
            "settings.serviceTier",
            "settings.serviceTier.default",
            "settings.fixedNotice",
            "settings.preferredSelection",
            "settings.selectionRequired",
            "settings.explicitRequired",
            "settings.developerModeRefreshRequired",
            "activity.approveSession"
          ].includes(key);
        if (audited && !allowedSameAsEnglish.has(key)) {
          expect(UI_TRANSLATIONS[locale][key], `${locale}:${key}`)
            .not.toBe(UI_TRANSLATIONS.en[key]);
        }
        const placeholders = (value: string) =>
          [...value.matchAll(/\{([A-Za-z][A-Za-z0-9]*)\}/g)]
            .map((match) => match[1])
            .sort();
        expect(placeholders(UI_TRANSLATIONS[locale][key]), `${locale}:${key}`)
          .toEqual(placeholders(UI_TRANSLATIONS.en[key]));
      }
    }
  });

  it("does not treat a synthesized effective locale as the automatic host locale", () => {
    expect(resolveHostUiLocaleTag.toString()).not.toContain("__name");
    expect(resolveHostUiLocaleTag(undefined, {
      hostLocale: null,
      "openai/locale": "en"
    }, "ko-KR")).toBe("ko-KR");
    expect(resolveHostUiLocaleTag(undefined, {
      hostLocale: "ko-KR",
      "openai/locale": "ko"
    }, "en-US")).toBe("ko-KR");
    expect(resolveHostUiLocaleTag("ja-JP", {
      hostLocale: "ko-KR"
    }, "en-US")).toBe("ja-JP");
    expect(resolveHostUiLocaleTag(undefined, {
      "openai/locale": "fr-FR"
    }, "ko-KR")).toBe("fr-FR");
    expect(resolveHostUiLocaleTag(undefined, {}, "")).toBe("en");
  });

  it("resolves BCP 47 language/script fallbacks without location inference", () => {
    expect(resolveUiLocale("ko-KR")).toBe("ko");
    expect(resolveUiLocale("ja_JP")).toBe("ja");
    expect(resolveUiLocale("zh-Hant-TW")).toBe("zh-Hant");
    expect(resolveUiLocale("zh-Hant-HK")).toBe("zh-Hant");
    expect(resolveUiLocale("zh-TW")).toBe("zh-Hant");
    expect(resolveUiLocale("zh-HK-x-private")).toBe("zh-Hant");
    expect(resolveUiLocale("zh-CN")).toBe("zh-Hans");
    expect(resolveUiLocale("zh-Hans-CN")).toBe("zh-Hans");
    expect(resolveUiLocale("es-MX")).toBe("es");
    expect(resolveUiLocale("fr-CA")).toBe("fr");
    expect(resolveUiLocale("de-DE")).toBe("de");
    expect(resolveUiLocale("pt-BR")).toBe("pt");
    expect(resolveUiLocale("ar-SA")).toBe("en");
    expect(resolveUiLocale("not a locale")).toBe("en");
    expect(resolveUiLocale(null)).toBe("en");
  });

  it("uses canonical lowercase effort labels while localizing descriptions", () => {
    expect(reasoningEffortPresentation(" HIGH ", "ko", "English upstream description")).toEqual({
      effort: "high",
      label: "high",
      description: "복잡한 작업을 더 깊게 검토하지만 응답 시간이 늘어날 수 있습니다.",
      descriptionSource: "localized"
    });
    expect(reasoningEffortPresentation("high", "en", "Upstream high description")).toMatchObject({
      label: "high",
      description: "Upstream high description",
      descriptionSource: "upstream"
    });
    expect(reasoningEffortPresentation("breakthrough", "ko", "Unlocalized upstream prose")).toEqual({
      effort: "breakthrough",
      label: "breakthrough",
      description: UI_TRANSLATIONS.ko["settings.effortFallbackDescription"],
      descriptionSource: "fallback"
    });
    expect(missingReasoningEffortTranslations(["high", "breakthrough", "breakthrough", "novel"]))
      .toEqual(["breakthrough", "novel"]);
  });

  it("serializes only the current cards within their byte budgets", () => {
    const serialized = serializedUiTranslations();
    expect(serialized).not.toContain("<");
    const serializedBundles = JSON.parse(serialized) as Record<string, Record<string, string>>;
    for (const bundle of Object.values(serializedBundles)) {
      expect(bundle).not.toHaveProperty("settings.cardVisibility");
      expect(bundle).not.toHaveProperty("settings.handoff");
      expect(bundle).not.toHaveProperty("activity.prompt.handoff");
    }
    expect(SETTINGS_CARD_HTML).toContain(
      serializedUiTranslations(["common", "settings", "effort", "history", "problem.historyNotice", "problem.automaticHistoryNotice"])
    );
    const dashboardBundles = JSON.parse(DASHBOARD_CARD_HTML.match(/const BUNDLES=(.*);/)![1]);
    const dashboardKeys = [...DASHBOARD_CARD_HTML.matchAll(/t\["([a-zA-Z0-9.-]+)"\]/g)].map(match => match[1]);
    for (const bundle of Object.values(dashboardBundles) as Record<string, string>[]) {
      for (const key of dashboardKeys) expect(bundle[key], key).toBeTruthy();
      expect(bundle).not.toHaveProperty("settings.title");
    }
    expect(SETTINGS_CARD_HTML).not.toContain('"activity.title"');
    expect(DASHBOARD_CARD_HTML).not.toContain('"settings.title"');
    expect(Buffer.byteLength(SETTINGS_CARD_HTML, "utf8")).toBeLessThanOrEqual(
      SETTINGS_CARD_HTML_MAX_BYTES
    );
    expect(Buffer.byteLength(DASHBOARD_CARD_HTML, "utf8")).toBeLessThanOrEqual(
      DASHBOARD_CARD_HTML_MAX_BYTES
    );
    expect(SETTINGS_CARD_HTML).toContain(PRODUCT_INFO.displayName);
    expect(SETTINGS_CARD_HTML).toContain('document.title=t["settings.title"]');
    expect(DASHBOARD_CARD_HTML).toContain('document.title=t["dashboard.title"]');
    expect(SETTINGS_CARD_HTML).not.toContain('id="dashboard-auto-open"');
    expect(SETTINGS_CARD_HTML).not.toContain('id="completion-follow-up"');
    expect(SETTINGS_CARD_HTML).not.toContain('data-i18n="settings.orchestrationDefaults"');
    expect(SETTINGS_CARD_HTML).not.toContain('data-i18n="settings.orchestrationDefaultsHint"');
    expect(SETTINGS_CARD_HTML).not.toContain('id="activity-card-visibility"');
    expect(SETTINGS_CARD_HTML).not.toContain('id="completion-handoff"');
    expect(SETTINGS_CARD_HTML).toContain('id="experimental-direct-result-delivery"');
    expect(SETTINGS_CARD_HTML).toContain("experimentalDirectResultDelivery:elements.directResultDelivery.checked");
    expect(DASHBOARD_CARD_HTML).toContain('callTool("codex_ui_read"');
    expect(DASHBOARD_CARD_HTML).not.toContain("codex_ui_stop");
    expect(DASHBOARD_CARD_HTML).toContain('if(row.controlKind!=="request")return');
    expect(DASHBOARD_CARD_HTML).toContain('controlAction("codex_interaction_respond"');
    expect(DASHBOARD_CARD_HTML).toContain('callTool("codex_ui_problem"');
    expect(DASHBOARD_CARD_HTML).not.toContain('callTool("codex_activity"');
    expect(`${SETTINGS_CARD_HTML}${DASHBOARD_CARD_HTML}${serialized}`)
      .not.toContain("MacBook Air");
  });

  it("localizes the stale-card recovery page from the browser locale", () => {
    const staleHtml = htmlForUiResource(
      "settings",
      "ui://codex-mcp-bridge/settings/not-retained.html",
      SETTINGS_CARD_HTML
    );
    expect(staleHtml).toContain("플러그인 새로고침 필요");
    expect(staleHtml).toContain('document.title=t["stale.title"]');
    expect(staleHtml).toContain("navigator.language");
    expect(staleHtml).not.toContain('<html lang="en">');
    expect(staleHtml).not.toContain("<title>Plugin refresh required</title>");
  });

  it("uses the standard Apps bridge and delegates exact completion delivery to Dashboard", () => {
    for (const html of [SETTINGS_CARD_HTML, DASHBOARD_CARD_HTML]) {
      expect(html).toContain('dir="auto"');
      expect(html).toContain('"openai/locale"');
      expect(html).toContain('"webplus/i18n"');
      expect(html).toContain('window.openai.locale');
      expect(html).toContain("resolveHostUiLocaleTag(");
      expect(html).not.toContain("openai/userLocation");
      expect(html).not.toMatch(/geolocation|navigator\.geolocation/i);
    }
    expect(DASHBOARD_CARD_HTML).toContain('rpcRequest("ui/message"');
    expect(DASHBOARD_CARD_HTML).toContain('standardToolCall("codex_ui_completion"');
    expect(DASHBOARD_CARD_HTML).toContain('standardToolCall("codex_status",{query:{kind:"completion",receipt}})');
    expect(DASHBOARD_CARD_HTML).not.toContain('Use only Codex MCP Bridge for ChatGPT');
    expect(DASHBOARD_CARD_HTML).toContain('completionIdentity("wait"');
    expect(DASHBOARD_CARD_HTML).toContain('completionMessageErrorDisposition(error)');
    expect(DASHBOARD_CARD_HTML).toContain('error.code="MCP_RPC_RESPONSE_ERROR"');
    expect(DASHBOARD_CARD_HTML).not.toContain('presentationToken');
    expect(DASHBOARD_CARD_HTML).toContain('message.method==="ui/notifications/tool-input"');
    expect(DASHBOARD_CARD_HTML).toContain('message.method==="ui/notifications/tool-result"');
    expect(DASHBOARD_CARD_HTML).toContain('globals,"toolInput"');
    expect(DASHBOARD_CARD_HTML).toContain('globals,"toolResponseMetadata"');
    expect(DASHBOARD_CARD_HTML).toContain('dataset.dashboardPresentation=presentationLinked?"ready"');
    expect(DASHBOARD_CARD_HTML.indexOf('window.addEventListener("message"'))
      .toBeLessThan(DASHBOARD_CARD_HTML.indexOf('standardBridgeReady=beginStandardBridge()'));
    expect(DASHBOARD_CARD_HTML).toContain('message.method==="ui/resource-teardown"');
    expect(DASHBOARD_CARD_HTML).toContain('tornDown=true;mounted=false');
    expect(DASHBOARD_CARD_HTML).toContain('if(tornDown)return;mounted=true');
    expect(DASHBOARD_CARD_HTML).toContain('document.visibilityState==="hidden"');
    expect(DASHBOARD_CARD_HTML).toContain('presentationDeliveryRoute==="live-card"');
    expect(DASHBOARD_CARD_HTML).toContain('dataset.completionDeliveryRoute=presentationDeliveryRoute||"missing"');
    expect(SETTINGS_CARD_HTML).toContain('callTool("codex_ui_read"');
    expect(SETTINGS_CARD_HTML).not.toContain('callTool("codex_settings",');
  });

  it("groups Dashboard rows by Activity identity while preserving nested Agent order", () => {
    const rows = [
      { activityKey: "activity-a", activityTitle: "Shared title", rowKey: "agent-a" },
      { activityKey: "activity-a", activityTitle: "Shared title", rowKey: "agent-b" },
      { activityKey: "activity-b", activityTitle: "Shared title", rowKey: "agent-c" }
    ];

    expect(groupDashboardRowsByActivity(rows)).toEqual([
      {
        activityKey: "activity-a",
        activityTitle: "Shared title",
        rows: [rows[0], rows[1]]
      },
      {
        activityKey: "activity-b",
        activityTitle: "Shared title",
        rows: [rows[2]]
      }
    ]);
  });

  it("deduplicates Dashboard history by opaque Activity identity and visible heading", () => {
    const enclosing = {
      activityKey: "activity-a",
      activityTitle: "Repeated title"
    };
    const sameActivity = { ...enclosing };
    const sameTitleDifferentActivity = {
      activityKey: "activity-b",
      activityTitle: "Repeated title"
    };
    const distinctActivity = {
      activityKey: "activity-c",
      activityTitle: "Different title"
    };
    expect(dashboardHistoryActivityIdentity({
      activityKey: "activity-a",
      activityTitle: "Repeated title"
    })).toBe("key:activity-a");
    expect(dashboardHistoryActivityIdentity({
      activityKey: "activity-b",
      activityTitle: "Repeated title"
    })).toBe("key:activity-b");
    expect(dashboardHistoryActivityIdentity({ activityTitle: "Legacy title" }))
      .toBe("legacy-title:Legacy title");
    expect(dashboardHistoryActivityIdentity(null)).toBeNull();
    expect(dashboardHistoryActivityHeading(sameActivity, enclosing, enclosing))
      .toEqual({ kind: "none" });
    expect(dashboardHistoryActivityHeading(
      sameTitleDifferentActivity,
      sameActivity,
      enclosing
    )).toEqual({ kind: "boundary" });
    expect(dashboardHistoryActivityHeading(
      distinctActivity,
      sameTitleDifferentActivity,
      enclosing
    )).toEqual({ kind: "title", title: "Different title" });
    expect(dashboardHistoryActivityHeading(
      { activityKey: "activity-d" },
      distinctActivity,
      enclosing
    )).toEqual({ kind: "boundary" });
  });

  it("uses the same localized Fast mode names in native settings and both cards", () => {
    const native = JSON.parse(readFileSync(new URL("../macos/Resources/Localization/Localizable.xcstrings", import.meta.url), "utf8"));
    for (const [locale, bundle] of Object.entries(UI_TRANSLATIONS)) {
      for (const key of [
        "settings.usePriority",
        "settings.usePriorityHint",
        "dashboard.execution.fast"
      ] as const) {
        expect(bundle[key], locale).toBe(native.strings[key].localizations[locale].stringUnit.value);
      }
      expect(bundle["settings.usePriority"]).toContain("Fast");
      expect(bundle["settings.automaticNotice"]).not.toContain("Priority");
      expect(bundle["settings.warning.legacyModel"]).not.toContain("Priority");
    }
    for (const serviceTier of ["priority", "fast", " FAST ", "PRIORITY"]) {
      expect(usesFastProcessing({ serviceTier })).toBe(true);
    }
    for (const serviceTier of [undefined, null, "", "default", "auto", "flex", "ultrafast", 1]) {
      expect(usesFastProcessing({ serviceTier })).toBe(false);
    }
    expect(usesFastProcessing(undefined)).toBe(false);
  });

  it("keeps next-run comparisons compatible for retained cards", () => {
    const latest = {
      model: "gpt-5.6-sol",
      modelDisplayName: "GPT-5.6 Sol",
      reasoningEffort: "max",
      isCurrent: false
    };
    const sameCurrent = {
      model: "GPT-5.6-SOL",
      modelDisplayName: "Renamed display label",
      reasoningEffort: "MAX",
      isCurrent: true
    };
    const changedCurrent = {
      ...sameCurrent,
      reasoningEffort: "high"
    };

    expect(dashboardExecutionsEqual(latest, sameCurrent)).toBe(true);
    expect(shouldShowDashboardNextExecution({ ...sameCurrent, serviceTier: "priority" }, latest)).toBe(true);
    expect(shouldShowDashboardNextExecution(sameCurrent, { ...latest, serviceTier: "fast" })).toBe(true);
    expect(dashboardExecutionsEqual(
      { ...latest, serviceTier: "priority" },
      { ...sameCurrent, serviceTier: " FAST " }
    )).toBe(true);
    expect(shouldShowDashboardNextExecution(sameCurrent, latest)).toBe(false);
    expect(shouldShowDashboardNextExecution(changedCurrent, latest)).toBe(true);
    expect(shouldShowDashboardNextExecution(sameCurrent, undefined)).toBe(true);
    expect(shouldShowDashboardNextExecution({ ...changedCurrent, isCurrent: false }, latest))
      .toBe(false);
    expect(shouldShowDashboardNextExecution(
      { ...sameCurrent, reroutedModel: "gpt-5.6-terra" },
      latest
    )).toBe(true);
    expect(UI_TRANSLATIONS.ko["dashboard.execution.next"])
      .toBe("다음 실행 설정: {execution}");
    expect(UI_TRANSLATIONS.ko["dashboard.execution.unavailable"])
      .toBe("모델 · 추론 확인 불가");
    expect(UI_TRANSLATIONS.ko["dashboard.history.activityBoundary"])
      .toBe("이전 Activity");
  });

  it("dispatches Dashboard conversation links through the host and falls back on host failure", async () => {
    const url = "https://chatgpt.com/c/41414141-4141-4141-8141-414141414141";
    const preventDefault = vi.fn();
    const fallback = vi.fn();
    const openExternal = vi.fn().mockResolvedValue(undefined);

    expect(dispatchDashboardExternalUrl(
      { preventDefault },
      url,
      { openExternal },
      fallback
    )).toBe(true);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(openExternal).toHaveBeenCalledWith({ href: url, redirectUrl: false });
    expect(fallback).not.toHaveBeenCalled();

    const rejectedFallback = vi.fn();
    dispatchDashboardExternalUrl(
      { preventDefault: vi.fn() },
      url,
      { openExternal: () => Promise.reject(new Error("host rejected deep link")) },
      rejectedFallback
    );
    await vi.waitFor(() => expect(rejectedFallback).toHaveBeenCalledWith(url));

    const nativeNavigation = { preventDefault: vi.fn() };
    expect(dispatchDashboardExternalUrl(nativeNavigation, url, undefined, fallback)).toBe(false);
    expect(nativeNavigation.preventDefault).not.toHaveBeenCalled();
  });

  it("preserves nested host and project errors instead of rendering object coercions", () => {
    expect(uiBridgeErrorMessage({
      code: -32603,
      message: {
        code: "PROJECT_CWD_NOT_ALLOWED",
        message: "The selected folder is unavailable."
      }
    }, "fallback")).toBe(
      "PROJECT_CWD_NOT_ALLOWED: The selected folder is unavailable."
    );
    expect(uiBridgeErrorMessage({
      error: {
        content: [{ type: "text", text: "PROJECT_CWD_CONFLICT: Duplicate project cwd." }]
      }
    }, "fallback")).toBe("PROJECT_CWD_CONFLICT: Duplicate project cwd.");
    expect(uiBridgeErrorMessage(new Error("[object Object]"), "fallback")).toBe("fallback");

    const circular: Record<string, unknown> = {};
    circular.error = circular;
    expect(uiBridgeErrorMessage(circular, "fallback")).toBe("fallback");
  });
});
