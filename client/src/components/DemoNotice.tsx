/**
 * Always-visible disclosure that this deployment is a demo with simulated billing. A plain `note` (not a live region) so it is
 * not re-announced on every navigation and does not compete with the status/alert banners.
 */
export function DemoNotice({ className = '' }: { className?: string }) {
  return (
    <div role="note" aria-label="Demo notice" className={`border border-amber-300 bg-amber-50 px-4 py-2 text-center text-sm text-amber-950 ${className}`}>
      <strong className="font-semibold">Demo only:</strong> billing is simulated. No real payments are made and no real money is processed.
    </div>
  );
}

/** Shown on the registration form: this is a public demo, so passwords must not be reused from real accounts. */
export function PasswordReuseWarning() {
  return (
    <p className="mt-4 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
      <strong className="font-semibold">Do not reuse a real password.</strong> This is a public demo. Choose a password you do not use anywhere else.
    </p>
  );
}
