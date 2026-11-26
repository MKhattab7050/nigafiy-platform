"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { AuthOptions, LoginResponse, SsoDiscoverResponse } from "@nigafiy/shared-types";
import { type ApiError, api } from "@/lib/api";
import { type Key, fill, useI18n } from "@/lib/i18n";
import { ChevronDown, Gauge, KeyRound, Layers, ShieldCheck } from "lucide-react";
import { browserTimeZone } from "@/lib/format";
import { TopologyArt } from "@/components/illustrations";
import { Logo } from "@/components/logo";
import { Button, ErrorNote, Field, Input, Notice } from "@/components/ui";
import { MfaChallenge, type MfaStep, resolveMfaStep } from "./mfa-steps";

const SIDE_ICONS = [Gauge, ShieldCheck, Layers];

/** "jane.doe@acme.com" → "Jane Doe": a starting value for the display name, editable under "More options". */
function nameFromEmail(email: string): string {
  const local = email.split("@")[0] ?? "";
  return local
    .split(/[._\-+]+/)
    .filter((w) => w && !/^\d+$/.test(w))
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ")
    .slice(0, 80);
}

const MORE_FIELDS = ["display_name", "organization_name", "site_name"];

type Step =
  | { kind: "credentials" }
  | { kind: "forgot"; sent: boolean }
  | { kind: "recover" }
  | { kind: "sso"; providers: SsoDiscoverResponse["providers"] | null }
  | MfaStep;

/** Error codes the SSO routes send back as ?sso_error=… (apps/api/src/modules/auth/sso). */
const SSO_ERRORS = new Set([
  "sso_unknown_provider", "sso_request_expired", "sso_request_used", "sso_browser_mismatch", "idp_denied", "idp_unreachable",
  "idp_bad_response", "idp_rejected", "idp_misconfigured", "invalid_id_token", "saml_invalid", "saml_wrong_recipient", "sso_no_email",
  "sso_email_unverified", "sso_domain_not_allowed", "sso_not_member", "sso_account_exists", "account_deactivated",
]);

export function AuthForm({ mode }: { mode: "login" | "register" }) {
  const { t, locale, setLocale } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const register = mode === "register";
  const [email, setEmail] = useState("");
  const [step, setStep] = useState<Step>({ kind: "credentials" });
  const [options, setOptions] = useState<AuthOptions | null>(null);
  // null = not typed: the default is shown (and sent), still editable under "More options".
  const [displayName, setDisplayName] = useState<string | null>(null);
  const [orgName, setOrgName] = useState<string | null>(null);
  const [siteName, setSiteName] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const nameValue = displayName ?? nameFromEmail(email);
  const orgValue = orgName ?? t("auth.defaultOrg");
  const siteValue = siteName ?? t("auth.defaultSite");
  const fieldError = (path: string) =>
    error?.details?.find((d) => d.path === path)?.message;
  const [ssoError, setSsoError] = useState<string | null>(null);
  const [recoverNote, setRecoverNote] = useState<string | null>(null);

  // Coming back from single sign-on: an error code in the query, or the local MFA step the
  // organization still requires in the fragment (never sent to a server). Both are removed from the
  // address bar once read.
  useEffect(() => {
    if (register) return;
    const url = new URL(window.location.href);
    const code = url.searchParams.get("sso_error");
    const hash = new URLSearchParams(url.hash.slice(1));
    const verify = hash.get("sso_mfa");
    const setup = hash.get("sso_mfa_setup");
    if (code) setSsoError(SSO_ERRORS.has(code) ? code : "sso_failed");
    if (code || verify || setup) window.history.replaceState(null, "", "/login");
    const res: LoginResponse | null = verify
      ? { ok: false, mfa_required: true, mfa_token: verify }
      : setup
        ? { ok: false, mfa_setup_required: true, mfa_token: setup }
        : null;
    if (res) {
      resolveMfaStep(res)
        .then((next) => next && setStep(next))
        .catch((err) => setError(err as ApiError));
    }
  }, [register]);

  async function findSso(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api<SsoDiscoverResponse>(`/auth/sso/discover?email=${encodeURIComponent(email.trim())}`);
      setStep({ kind: "sso", providers: res.providers });
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    let active = true;
    api<AuthOptions>("/auth/options")
      .then((res) => {
        if (active) setOptions(res);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = Object.fromEntries(new FormData(e.currentTarget)) as Record<
      string,
      string
    >;
    setBusy(true);
    setError(null);
    try {
      const timezone = browserTimeZone();
      if (register) {
        await api("/auth/register", {
          method: "POST",
          body: {
            email,
            password: form.password,
            display_name: nameValue.trim() || email.split("@")[0],
            organization_name: orgValue.trim(),
            site_name: siteValue.trim(),
            // The first site starts in this browser's time zone (editable later on the site card).
            ...(timezone ? { timezone } : {}),
          },
        });
        window.location.href = "/";
        return;
      }

      const res = await api<LoginResponse>("/auth/login", {
        method: "POST",
        timeoutMs: 15_000,
        body: { email, password: form.password },
      });

      const nextMfa = await resolveMfaStep(res);
      if (nextMfa) {
        setStep(nextMfa);
        setBusy(false);
        return;
      }
      window.location.href = "/";
    } catch (err) {
      const apiError = err as ApiError;
      setError(apiError);
      // A problem with a field hidden under "More options" opens it, so the message is visible.
      if (apiError.details?.some((d) => MORE_FIELDS.includes(d.path))) setMore(true);
      setBusy(false);
    }
  }

  async function submitForgot(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/auth/forgot-password", {
        method: "POST",
        body: { email: email.trim() },
      });
      setStep({ kind: "forgot", sent: true });
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy(false);
    }
  }

  /** "Use a recovery code": one saved code + a new password, then the normal sign-in (two-factor sign-in still applies). */
  async function submitRecover(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    if (form.new_password !== form.repeat) {
      setError({ status: 400, code: "validation_error", message: t("ownpw.mismatch"), details: [{ path: "repeat", message: t("ownpw.mismatch") }] } as ApiError);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const recovered = await api<{ ok: true; codes_left: number }>("/auth/recover", {
        method: "POST",
        body: { email: email.trim(), code: form.code, new_password: form.new_password },
      });
      setRecoverNote(fill(t("ownpw.recoverLeft"), { count: recovered.codes_left }));
      const res = await api<LoginResponse>("/auth/login", {
        method: "POST",
        timeoutMs: 15_000,
        body: { email: email.trim(), password: form.new_password },
      });
      const nextMfa = await resolveMfaStep(res);
      if (nextMfa) {
        setStep(nextMfa);
        setBusy(false);
        return;
      }
      window.location.href = "/";
    } catch (err) {
      setError(err as ApiError);
      setBusy(false);
    }
  }

  const allowRegistration = options?.allow_registration ?? true;

  return (
    <div className="grid min-h-dvh lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
      <div className="flex flex-col items-center justify-center px-4 py-10">
        <div className="w-full max-w-sm">
          <div className="mb-6 flex items-center justify-between">
            <Logo />
            <button
              type="button"
              onClick={() => setLocale(locale === "en" ? "ar" : "en")}
              className="rounded-[5px] px-1.5 py-1 text-xs text-muted hover:bg-raised hover:text-fg"
              lang={locale === "en" ? "ar" : "en"}
            >
              {locale === "en" ? "العربية" : "English"}
            </button>
          </div>
          <div className="rounded-[var(--radius-card)] border border-line bg-surface p-6 shadow-[var(--shadow-card)]">
            {step.kind === "mfa_verify" || step.kind === "mfa_setup" || step.kind === "mfa_recovery" ? (
              <MfaChallenge
                step={step}
                onStepChange={setStep}
                onBack={() => {
                  setError(null);
                  setStep({ kind: "credentials" });
                }}
              />
            ) : step.kind === "sso" ? (
              <>
                <h1 className="text-xl font-semibold tracking-[-0.01em]">{t("auth.ssoTitle")}</h1>
                <p className="mt-1 text-[13px] text-muted">{t("auth.ssoDesc")}</p>
                <form onSubmit={findSso} className="mt-5 space-y-4" noValidate>
                  <Field label={t("auth.email")} error={fieldError("email")}>
                    {(id) => (
                      <Input
                        id={id}
                        name="email"
                        type="email"
                        autoComplete="email"
                        required
                        dir="ltr"
                        value={email}
                        onChange={(e) => {
                          setEmail(e.target.value);
                          setStep({ kind: "sso", providers: null });
                        }}
                      />
                    )}
                  </Field>
                  {error && !error.details?.length && <ErrorNote error={error} />}
                  {step.providers === null ? (
                    <Button type="submit" variant="primary" busy={busy} disabled={!email.trim()} className="w-full">
                      {t("auth.ssoContinue")}
                    </Button>
                  ) : step.providers.length === 0 ? (
                    <Notice>{t("auth.ssoNone")}</Notice>
                  ) : (
                    <div className="space-y-2">
                      {step.providers.map((p) => (
                        <a
                          key={p.id}
                          href={`/api/v1/auth/sso/${p.id}/start?login_hint=${encodeURIComponent(email.trim())}`}
                          className="flex h-9 w-full items-center justify-center gap-2 rounded-[var(--radius-control)] bg-accent px-3.5 text-[13px] font-medium text-on-accent hover:bg-accent-strong"
                        >
                          <KeyRound className="size-3.5" aria-hidden />
                          {t("auth.ssoWith")} <bdi dir="auto">{p.name}</bdi>
                        </a>
                      ))}
                    </div>
                  )}
                  <Button
                    type="button"
                    variant="ghost"
                    className="w-full"
                    onClick={() => {
                      setError(null);
                      setStep({ kind: "credentials" });
                    }}
                  >
                    {t("auth.backToSignIn")}
                  </Button>
                </form>
              </>
            ) : step.kind === "recover" ? (
              <>
                <h1 className="text-xl font-semibold tracking-[-0.01em]">{t("ownpw.recoverTitle")}</h1>
                <p className="mt-1 text-[13px] text-muted">{t("ownpw.recoverDesc")}</p>
                <form onSubmit={submitRecover} className="mt-5 space-y-4" noValidate>
                  <Field label={t("auth.email")} error={fieldError("email")}>
                    {(id) => (
                      <Input id={id} name="email" type="email" autoComplete="email" required dir="ltr" value={email} onChange={(e) => setEmail(e.target.value)} />
                    )}
                  </Field>
                  <Field label={t("ownpw.recoverCode")} error={fieldError("code")}>
                    {(id) => (
                      <Input id={id} name="code" autoComplete="one-time-code" autoCapitalize="characters" spellCheck={false} required dir="ltr" placeholder="XXXX-XXXX-XXXX-XXXX" className="mono" />
                    )}
                  </Field>
                  <Field label={t("ownpw.password")} hint={t("ownpw.passwordHint")} error={fieldError("new_password")}>
                    {(id) => <Input id={id} name="new_password" type="password" autoComplete="new-password" required minLength={10} dir="ltr" />}
                  </Field>
                  <Field label={t("ownpw.repeat")} error={fieldError("repeat")}>
                    {(id) => <Input id={id} name="repeat" type="password" autoComplete="new-password" required dir="ltr" />}
                  </Field>
                  {recoverNote && <Notice>{recoverNote}</Notice>}
                  {error && !error.details?.length && <ErrorNote error={error} />}
                  <Button type="submit" variant="primary" busy={busy} disabled={!email.trim()} className="w-full">
                    {t("ownpw.recoverSubmit")}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    className="w-full"
                    onClick={() => {
                      setError(null);
                      setStep({ kind: "credentials" });
                    }}
                  >
                    {t("auth.backToSignIn")}
                  </Button>
                </form>
              </>
            ) : step.kind === "forgot" ? (
              <>
                <h1 className="text-xl font-semibold tracking-[-0.01em]">
                  {t("auth.forgotTitle")}
                </h1>
                <p className="mt-1 text-[13px] text-muted">
                  {t("auth.forgotDesc")}
                </p>
                {options && !options.account_mail_configured && (
                  <p className="mt-3 rounded-md border border-warn/30 bg-warn/10 px-3 py-2 text-xs leading-relaxed text-fg">
                    {t("auth.forgotNoMailHint")}
                  </p>
                )}
                {step.sent ? (
                  <div className="mt-4 space-y-4">
                    <Notice>{t("auth.forgotSent")}</Notice>
                    <Button
                      type="button"
                      variant="secondary"
                      className="w-full"
                      onClick={() => {
                        setError(null);
                        setStep({ kind: "credentials" });
                      }}
                    >
                      {t("auth.backToSignIn")}
                    </Button>
                  </div>
                ) : (
                  <form onSubmit={submitForgot} className="mt-5 space-y-4">
                    <Field label={t("auth.email")} error={fieldError("email")}>
                      {(id) => (
                        <Input
                          id={id}
                          name="email"
                          type="email"
                          autoComplete="email"
                          required
                          dir="ltr"
                          value={email}
                          onChange={(e) => setEmail(e.target.value)}
                        />
                      )}
                    </Field>
                    {error && !error.details?.length && (
                      <ErrorNote error={error} />
                    )}
                    <Button
                      type="submit"
                      variant="primary"
                      busy={busy}
                      disabled={!email.trim()}
                      className="w-full"
                    >
                      {t("auth.forgotSend")}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      className="w-full"
                      onClick={() => {
                        setError(null);
                        setStep({ kind: "credentials" });
                      }}
                    >
                      {t("auth.backToSignIn")}
                    </Button>
                  </form>
                )}
              </>
            ) : register && !allowRegistration ? (
              <div className="space-y-4">
                <h1 className="text-xl font-semibold tracking-[-0.01em]">
                  {t("auth.registerTitle")}
                </h1>
                <Notice>{t("auth.registrationDisabled")}</Notice>
                <Link
                  href="/login"
                  className="inline-flex h-9 w-full items-center justify-center rounded-[var(--radius-control)] bg-accent px-3.5 text-[13px] font-medium text-on-accent hover:bg-accent-strong"
                >
                  {t("auth.signIn")}
                </Link>
              </div>
            ) : (
              <>
                <h1 className="text-xl font-semibold tracking-[-0.01em]">
                  {register ? t("auth.registerTitle") : t("auth.signInTitle")}
                </h1>
                <p className="mt-1 text-[13px] text-muted">{t("app.tagline")}</p>
                <form onSubmit={submit} className="mt-5 space-y-4" noValidate>
                  <Field label={t("auth.email")} error={fieldError("email")}>
                    {(id) => (
                      <Input
                        id={id}
                        name="email"
                        type="email"
                        autoComplete="email"
                        required
                        dir="ltr"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                      />
                    )}
                  </Field>
                  <div>
                    <Field
                      label={t("auth.password")}
                      hint={register ? t("auth.passwordHint") : undefined}
                      error={fieldError("password")}
                    >
                      {(id) => (
                        <Input
                          id={id}
                          name="password"
                          type="password"
                          autoComplete={
                            register ? "new-password" : "current-password"
                          }
                          required
                          minLength={register ? 10 : 1}
                          dir="ltr"
                        />
                      )}
                    </Field>
                    {!register && (
                      <div className="mt-1.5 flex flex-wrap justify-end gap-x-4 gap-y-1">
                        <button
                          type="button"
                          onClick={() => {
                            setError(null);
                            setRecoverNote(null);
                            setStep({ kind: "recover" });
                          }}
                          className="text-xs font-medium text-accent-hover hover:underline"
                        >
                          {t("ownpw.recoverLink")}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setError(null);
                            setStep({ kind: "forgot", sent: false });
                          }}
                          className="text-xs font-medium text-accent-hover hover:underline"
                        >
                          {t("auth.forgotPassword")}
                        </button>
                      </div>
                    )}
                  </div>
                  {register && (
                    <div>
                      <button
                        type="button"
                        onClick={() => setMore(!more)}
                        aria-expanded={more}
                        aria-controls="register-more"
                        className="inline-flex h-8 items-center gap-1 rounded px-1 text-xs font-medium text-muted hover:text-fg"
                      >
                        {t("auth.moreOptions")}
                        <ChevronDown
                          className={`size-3.5 transition-transform duration-150 ${more ? "rotate-180" : ""}`}
                          aria-hidden
                        />
                      </button>
                      {!more && (
                        <p className="text-xs leading-relaxed text-faint">
                          {t("auth.moreOptionsHint")}
                        </p>
                      )}
                      <div id="register-more" hidden={!more} className="mt-3 space-y-4">
                        <Field
                          label={t("auth.yourName")}
                          error={fieldError("display_name")}
                        >
                          {(id) => (
                            <Input
                              id={id}
                              autoComplete="name"
                              maxLength={80}
                              value={nameValue}
                              onChange={(e) => setDisplayName(e.target.value)}
                            />
                          )}
                        </Field>
                        <Field
                          label={t("auth.orgName")}
                          error={fieldError("organization_name")}
                        >
                          {(id) => (
                            <Input
                              id={id}
                              autoComplete="organization"
                              maxLength={80}
                              value={orgValue}
                              onChange={(e) => setOrgName(e.target.value)}
                            />
                          )}
                        </Field>
                        <Field
                          label={t("auth.siteName")}
                          hint={t("auth.siteHint")}
                          error={fieldError("site_name")}
                        >
                          {(id) => (
                            <Input
                              id={id}
                              maxLength={80}
                              value={siteValue}
                              onChange={(e) => setSiteName(e.target.value)}
                            />
                          )}
                        </Field>
                      </div>
                    </div>
                  )}
                  {error && !error.details?.length && <ErrorNote error={error} />}
                  {ssoError && !register && (
                    <p role="alert" className="rounded-md border border-crit/30 bg-crit/10 px-3 py-2 text-xs leading-relaxed text-fg">
                      {t("auth.ssoFailed")} {t(`auth.ssoError.${ssoError}` as Key)}
                    </p>
                  )}
                  <Button
                    type="submit"
                    variant="primary"
                    busy={busy}
                    className="w-full"
                  >
                    {register ? t("auth.createAccount") : t("auth.signIn")}
                  </Button>
                  {!register && options?.sso_available && (
                    <Button
                      type="button"
                      variant="secondary"
                      className="w-full"
                      onClick={() => {
                        setError(null);
                        setSsoError(null);
                        setStep({ kind: "sso", providers: null });
                      }}
                    >
                      <KeyRound className="size-3.5" aria-hidden />
                      {t("auth.ssoButton")}
                    </Button>
                  )}
                </form>
              </>
            )}
          </div>
          {step.kind === "credentials" && (register || allowRegistration) && (
            <p className="mt-4 text-center text-[13px] text-muted">
              {register ? t("auth.haveAccount") : t("auth.noAccount")}{" "}
              <Link
                href={register ? "/login" : "/register"}
                className="font-medium text-accent-hover hover:underline"
              >
                {register ? t("auth.signIn") : t("auth.createAccount")}
              </Link>
            </p>
          )}
        </div>
      </div>
      {/* Context panel: what the product does, beside the form on wide screens only. */}
      <aside className="hidden flex-col justify-center gap-8 border-s border-line bg-sunken px-12 py-12 lg:flex">
        <div className="max-w-md text-faint">
          <TopologyArt className="w-full max-w-[380px]" />
        </div>
        <div className="max-w-md">
          <p className="text-[22px] font-semibold leading-snug tracking-[-0.01em] text-fg">
            {t("auth.sideTitle")}
          </p>
          <ul className="mt-5 space-y-3 text-[13.5px] text-muted">
            {(
              ["auth.sidePoint1", "auth.sidePoint2", "auth.sidePoint3"] as const
            ).map((k, i) => {
              const Icon = SIDE_ICONS[i]!;
              return (
                <li key={k} className="flex items-start gap-3">
                  <span className="mt-px grid size-6 shrink-0 place-items-center rounded-[6px] border border-line bg-surface text-accent-hover">
                    <Icon className="size-3.5" aria-hidden />
                  </span>
                  {t(k)}
                </li>
              );
            })}
          </ul>
        </div>
      </aside>
    </div>
  );
}
