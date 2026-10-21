"use client";

import { cn } from "@/shared/utils/cn";

// Props for a field holding an API key or token, not a login password. Chrome
// ignores autoComplete="off" once a form has a real password field: it offers
// saved logins and treats the field before it as the username. So render plain
// text masked with CSS (Chrome, Safari, Firefox 114+), and opt out of the
// third-party managers too. Spread onto a raw <input>, or pass
// `ignorePasswordManagers` to <Input>.
export const SECRET_INPUT_PROPS = {
  type: "text",
  style: { WebkitTextSecurity: "disc" },
  spellCheck: false,
  autoCapitalize: "off",
  autoCorrect: "off",
  autoComplete: "off",
  "data-1p-ignore": true,
  "data-lpignore": "true",
  "data-bwignore": true,
  "data-form-type": "other",
};

export default function Input({
  label,
  type = "text",
  placeholder,
  value,
  onChange,
  error,
  hint,
  icon,
  disabled = false,
  required = false,
  className,
  inputClassName,
  // API keys and tokens aren't logins: keep every password manager away (see SECRET_INPUT_PROPS).
  ignorePasswordManagers = false,
  style,
  ...props
}) {
  // Only a password-type field gets masked; other fields just skip autofill.
  const secretProps = ignorePasswordManagers
    ? type === "password"
      ? { ...SECRET_INPUT_PROPS, style: { ...SECRET_INPUT_PROPS.style, ...style } }
      : { ...SECRET_INPUT_PROPS, type, style }
    : { type, style };
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      {label && (
        <label className="text-sm font-medium text-text-main">
          {label}
          {required && <span className="text-red-500 ml-1">*</span>}
        </label>
      )}
      <div className="relative">
        {icon && (
          <div className="absolute inset-y-0 left-0 flex items-center pl-3 pointer-events-none text-text-muted">
            <span className="material-symbols-outlined text-[20px]">{icon}</span>
          </div>
        )}
        <input
          placeholder={placeholder}
          value={value}
          onChange={onChange}
          disabled={disabled}
          className={cn(
            "w-full py-2.5 px-3 text-sm text-text-main bg-surface-2 rounded-[10px]",
            "border border-transparent placeholder-text-muted/70",
            "focus:outline-none focus:ring-2 focus:ring-brand-500/30 focus:border-brand-500/40",
            "transition-all duration-150 ease-out disabled:opacity-50 disabled:cursor-not-allowed",
            // iOS zoom fix
            "text-[16px] sm:text-sm",
            icon && "pl-10",
            error && "ring-1 ring-red-500 focus:ring-2 focus:ring-red-500/40 border-red-500/40",
            inputClassName
          )}
          {...secretProps}
          {...props}
        />
      </div>
      {error && (
        <p className="text-xs text-red-500 flex items-center gap-1">
          <span className="material-symbols-outlined text-[14px]">error</span>
          {error}
        </p>
      )}
      {hint && !error && (
        <p className="text-xs text-text-muted">{hint}</p>
      )}
    </div>
  );
}
