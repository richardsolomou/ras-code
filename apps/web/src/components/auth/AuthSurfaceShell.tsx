import type { ReactNode } from "react";

import { APP_DISPLAY_NAME } from "../../branding";

/**
 * Full-screen card for standalone auth pages, mirroring the pairing surface's
 * treatment. Used by the CLI-connect authorize and callback surfaces.
 */
export function AuthSurfaceShell({ children }: { readonly children: ReactNode }) {
  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background px-4 py-10 text-foreground sm:px-6">
      <section className="relative w-full max-w-xl overflow-hidden rounded-2xl border border-border/80 bg-card shadow-2xl shadow-black/20">
        <header className="border-border/80 border-b px-5 py-4 sm:px-6">
          <p className="text-[10px] font-semibold tracking-[0.2em] text-muted-foreground uppercase">
            {APP_DISPLAY_NAME}
          </p>
        </header>
        <div className="p-6 sm:p-8">{children}</div>
      </section>
    </div>
  );
}
