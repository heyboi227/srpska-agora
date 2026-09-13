import Link from "next/link";

export default function NotFound() {
  return (
    <div className="mx-auto max-w-lg py-16 text-center">
      <h1 className="text-2xl font-semibold">Stranica nije pronađena</h1>
      <p className="mt-2 text-text-muted">
        Tema, zajednica ili sagovornik koje tražite ne postoje ili su uklonjeni.
      </p>
      <p className="mt-6">
        <Link href="/">Nazad na početnu</Link>
      </p>
    </div>
  );
}
