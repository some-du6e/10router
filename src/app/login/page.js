"use client";

import { useState, useEffect } from "react";
import { Button } from "@/shared/components";
import useThemeStore from "@/store/themeStore";
import styles from "./login.module.css";

function PasswordField({ id, label, ...props }) {
  const [visible, setVisible] = useState(false);
  return (
    <div className={styles.field}>
      <label htmlFor={id}>{label}</label>
      <div className={styles.inputWrap}>
        <input id={id} type={visible ? "text" : "password"} {...props} />
        <button type="button" className={styles.reveal} aria-label={visible ? "Hide password" : "Show password"} aria-pressed={visible} onClick={() => setVisible(!visible)}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
            <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
            <circle cx="12" cy="12" r="3" />
            {visible && <path d="m3 3 18 18" />}
          </svg>
        </button>
      </div>
    </div>
  );
}

export default function LoginPage() {
  const toggleTheme = useThemeStore((state) => state.toggleTheme);
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [resetHint, setResetHint] = useState("");
  const [retryAfter, setRetryAfter] = useState(0);
  const [loading, setLoading] = useState(false);
  const [hasPassword, setHasPassword] = useState(null);
  const [authMode, setAuthMode] = useState("password");
  const [ssoType, setSsoType] = useState("oidc");
  const [oidcConfigured, setOidcConfigured] = useState(false);
  const [oidcLoginLabel, setOidcLoginLabel] = useState("Sign in with OIDC");
  const [samlConfigured, setSamlConfigured] = useState(false);
  const [samlLoginLabel, setSamlLoginLabel] = useState("Sign in with SAML SSO");
  const [mustChange, setMustChange] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [legacyPassword, setLegacyPassword] = useState(false);

  const MIN_PASSWORD_LENGTH = 8;

  // Countdown for rate-limit
  useEffect(() => {
    if (retryAfter <= 0) return;
    const id = setInterval(() => setRetryAfter((s) => (s > 0 ? s - 1 : 0)), 1000);
    return () => clearInterval(id);
  }, [retryAfter]);

  useEffect(() => {
    async function checkAuth() {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      const baseUrl = typeof window !== "undefined" ? window.location.origin : "";

      try {
        const res = await fetch(`${baseUrl}/api/auth/status`, {
          signal: controller.signal,
        });
        clearTimeout(timeoutId);

        if (res.ok) {
          const data = await res.json();
          if (data.needsSetup === true) {
            window.location.assign("/setup");
            return;
          }
          // A restricted session that reloaded the page lands back here: keep
          // it on the change form instead of bouncing it to a locked dashboard.
          if (data.authenticated === true && data.mustChangePassword === true) {
            setMustChange(true);
            setHasPassword(false);
            setLegacyPassword(true);
            return;
          }
          if (data.authenticated === true || data.requireLogin === false) {
            window.location.assign("/dashboard");
            return;
          }
          setHasPassword(!!data.hasPassword);
          setLegacyPassword(data.mustChangePassword === true);
          setAuthMode(data.authMode || "password");
          setSsoType(data.ssoType || "oidc");
          setOidcConfigured(data.oidcConfigured === true);
          setOidcLoginLabel(data.oidcLoginLabel || "Sign in with OIDC");
          setSamlConfigured(data.samlConfigured === true);
          setSamlLoginLabel(data.samlLoginLabel || "Sign in with SAML SSO");
        } else {
          // Safe fallback on non-OK response to avoid infinite loading state.
          setHasPassword(true);
        }
      } catch (err) {
        clearTimeout(timeoutId);
        setHasPassword(true);
      }
    }
    checkAuth();
  }, []);

  const handleLogin = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError("");
    setResetHint("");

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });

      if (res.ok) {
        const data = await res.json();
        if (data.mustChangePassword) {
          setMustChange(true);
          return;
        }
        window.location.assign("/dashboard");
      } else {
        const data = await res.json();
        if (data.needsSetup === true) {
          window.location.assign("/setup");
          return;
        }
        setError(data.error || "Invalid password");
        if (data.resetHint) setResetHint(data.resetHint);
        if (data.retryAfter) setRetryAfter(Number(data.retryAfter));
      }
    } catch (err) {
      setError("An error occurred. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  // Force a new password before entering the dashboard (default + remote).
  const handleSetNewPassword = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      // Dedicated endpoint: the restricted session issued at legacy login is
      // only accepted here, and the old password is not asked for again.
      const res = await fetch("/api/auth/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newPassword }),
      });
      if (res.ok) {
        window.location.assign("/dashboard");
      } else {
        const data = await res.json();
        setError(data.error || "Failed to set password");
      }
    } catch (err) {
      setError("An error occurred. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const handleOidcLogin = () => {
    window.location.href = "/api/auth/oidc/start";
  };

  const handleSamlLogin = () => {
    window.location.href = "/api/auth/saml/start";
  };

  const isSsoEnabled = ["sso", "oidc", "saml", "both"].includes(authMode);
  const activeSsoType = ssoType || (authMode === "saml" ? "saml" : "oidc");

  const samlAvailable = isSsoEnabled && activeSsoType === "saml" && samlConfigured;
  const oidcAvailable = isSsoEnabled && activeSsoType === "oidc" && oidcConfigured;
  const ssoAvailable = samlAvailable || oidcAvailable;

  const passwordAvailable = authMode === "password" || authMode === "both" || !ssoAvailable;

  return (
    <main className={styles.page}>
      <div className={styles.atmosphere} aria-hidden="true">
        <svg viewBox="0 0 1440 900" preserveAspectRatio="xMidYMid slice">
          <g className={styles.routes}>
            <path d="M-80 650h290q40 0 40-40V330q0-40 40-40h160" />
            <path d="M-50 690h320q40 0 40-40V390q0-40 40-40h100" />
            <path d="M990 550h130q40 0 40-40V240q0-40 40-40h320" />
            <path d="M990 610h190q40 0 40-40V300q0-40 40-40h230" />
            <path d="M380 950V790q0-40 40-40h60" />
            <path d="M1050-60v150q0 40-40 40h-70" />
          </g>
          <g className={styles.nodes}>
            <circle cx="210" cy="650" r="4" /><circle cx="310" cy="450" r="3" />
            <circle cx="1160" cy="360" r="4" /><circle cx="1280" cy="260" r="3" />
            <circle cx="380" cy="850" r="3" /><circle cx="1050" cy="90" r="3" />
          </g>
        </svg>
      </div>

      <button type="button" className={styles.themeToggle} onClick={toggleTheme} aria-label="Toggle color theme">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
          <path d="M20.5 13A8.5 8.5 0 0 1 11 3.5 8.5 8.5 0 1 0 20.5 13Z" />
        </svg>
      </button>

      <div className={styles.content}>
        <div className={styles.brand}>
          <div className={styles.mark}>
            <svg viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
              <path d="M16 12V6m-3 12-6 4m12-4 6 4m-9-4v8M12 14 7 10m13 4 5-4" />
              <circle cx="16" cy="16" r="4" /><circle cx="16" cy="4" r="2" />
              <circle cx="5" cy="9" r="2" /><circle cx="27" cy="9" r="2" />
              <circle cx="5" cy="23" r="2" /><circle cx="27" cy="23" r="2" />
              <circle cx="16" cy="28" r="2" />
            </svg>
          </div>
          <span>10router</span>
        </div>

        <section className={styles.card} aria-labelledby="login-heading" aria-busy={hasPassword === null}>
          <header className={styles.heading}>
            <h1 id="login-heading">{mustChange ? "A fresh start." : "Welcome back."}</h1>
            <p>{mustChange ? "Set a new password to continue." : "Sign in to your router."}</p>
          </header>

          {hasPassword === null ? (
            <div className={styles.loading} role="status"><span />Loading your instance...</div>
          ) : mustChange ? (
            <form onSubmit={handleSetNewPassword} className={styles.form}>
              <PasswordField id="new-password" label="New password" placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`} value={newPassword} onChange={(e) => setNewPassword(e.target.value)} required autoFocus autoComplete="new-password" aria-describedby={error ? "login-error" : undefined} />
              {error && <p id="login-error" role="alert" className={styles.error}>{error}</p>}
              <Button type="submit" className={styles.submit} loading={loading} disabled={newPassword.length < MIN_PASSWORD_LENGTH}>Set password</Button>
            </form>
          ) : (
            <div className={styles.form}>
              {samlAvailable && <Button type="button" className={styles.submit} onClick={handleSamlLogin}>{samlLoginLabel}</Button>}
              {oidcAvailable && <Button type="button" className={styles.submit} onClick={handleOidcLogin}>{oidcLoginLabel}</Button>}
              {ssoAvailable && passwordAvailable && <div className={styles.divider}><span>or use your password</span></div>}

              {passwordAvailable ? (
                <form onSubmit={handleLogin} className={styles.form}>
                  {isSsoEnabled && !ssoAvailable && <p className={styles.notice}>{activeSsoType === "saml" ? "SAML SSO" : "OIDC"} setup is incomplete. Sign in with your password to recover access.</p>}
                  <PasswordField id="password" label="Password" placeholder="Enter your password" value={password} onChange={(e) => setPassword(e.target.value)} required autoFocus={!ssoAvailable} autoComplete="current-password" aria-invalid={!!error} aria-describedby={error ? "login-error" : undefined} />
                  {error && <p id="login-error" role="alert" className={styles.error}>{error}</p>}
                  {retryAfter > 0 && <p className={styles.notice} role="status">Too many attempts. Try again in {retryAfter}s.</p>}
                  <Button type="submit" className={styles.submit} loading={loading} disabled={retryAfter > 0}>
                    {retryAfter > 0 ? `Wait ${retryAfter}s` : "Sign in"}
                    {!loading && retryAfter === 0 && <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true"><path d="M5 12h14m-5-5 5 5-5 5" /></svg>}
                  </Button>
                  {legacyPassword && <p className={styles.notice}>This instance uses the old default password. You will set a new one after signing in.</p>}
                  <details className={styles.recovery} key={resetHint ? "reset" : "default"} open={resetHint ? true : undefined}>
                    <summary>Forgot your password?</summary>
                    <p>On the host, open the <code>10router</code> CLI, choose <strong>Settings</strong>, then <strong>Reset Password</strong>. Finish setup with the token it prints.</p>
                  </details>
                </form>
              ) : error && <p id="login-error" role="alert" className={styles.error}>{error}</p>}
            </div>
          )}
        </section>
        <footer className={styles.footer}>One endpoint for your AI providers.</footer>
      </div>
    </main>
  );
}
