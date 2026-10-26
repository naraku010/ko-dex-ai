"use client";

import type { CredentialField } from "@/types/assistant";

export default function CredentialFields({
  fields,
  values,
  onChange,
  disabled = false,
}: {
  fields: CredentialField[];
  values: Record<string, string>;
  onChange: (key: string, value: string) => void;
  disabled?: boolean;
}) {
  if (fields.length === 0) return null;

  return (
    <div className="space-y-3">
      {fields.map((field) => (
        <div key={field.key}>
          <label className="mb-1 block text-xs font-semibold" style={{ color: "var(--dc-secondary)" }}>
            {field.label}
            {field.required ? <span style={{ color: "var(--dc-danger)" }}> *</span> : null}
          </label>
          <input
            value={values[field.key] ?? ""}
            onChange={(e) => onChange(field.key, e.target.value)}
            type={field.secret ? "password" : "text"}
            disabled={disabled}
            autoComplete={field.secret ? "new-password" : "off"}
            placeholder={field.hint || field.label}
            className="h-9 w-full rounded px-3 text-sm outline-none disabled:opacity-50"
            style={{
              background: "var(--dc-bg)",
              color: "var(--dc-text)",
              border: "1px solid var(--dc-border)",
              fontFamily: "var(--font-mono)",
            }}
          />
          {field.hint ? (
            <p className="mt-1 text-[11px]" style={{ color: "var(--dc-faint)" }}>{field.hint}</p>
          ) : null}
        </div>
      ))}
    </div>
  );
}
