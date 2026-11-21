import { Suspense, type ReactNode } from "react";
import { Shell } from "@/components/Shell";

function Loading() {
  return <div className="shell" style={{ gridTemplateColumns: "1fr" }} />;
}

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <Suspense fallback={<Loading />}>
      <Shell>{children}</Shell>
    </Suspense>
  );
}
