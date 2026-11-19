export default function LoginPage() {
  return (
    <main className="grid min-h-screen place-items-center p-6">
      <div className="max-w-sm rounded-2xl bg-surface p-8 text-center shadow-sm ring-1 ring-black/5">
        <h1 className="text-xl font-semibold">Staff sign-in</h1>
        <p className="mt-2 text-sm text-muted">
          Staff authentication (with mandatory MFA) is implemented in Phase 2. No sign-in form is shown until the backend can verify it.
        </p>
      </div>
    </main>
  )
}
