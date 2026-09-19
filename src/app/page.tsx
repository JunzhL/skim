export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center px-6 py-16">
      <p className="mb-3 text-sm font-medium uppercase tracking-[0.2em] text-neutral-500">Skim</p>
      <h1 className="text-5xl font-semibold tracking-tight">Skill Manager</h1>
      <div className="mt-8 rounded-xl border border-neutral-200 bg-white p-5 shadow-sm">
        <div className="flex items-center gap-3">
          <span aria-hidden="true" className="h-2.5 w-2.5 rounded-full bg-emerald-500" />
          <p className="font-medium">Managed repository connected</p>
        </div>
        <p className="mt-2 text-sm text-neutral-600">
          Runtime configuration was validated before this server started.
        </p>
      </div>
    </main>
  );
}
