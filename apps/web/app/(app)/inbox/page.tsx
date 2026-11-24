import { Suspense } from "react";
import { Skeleton } from "@/components/ui";
import InboxView from "./InboxView";

export default function Page() {
  return (
    <Suspense fallback={<Skeleton h={480} />}>
      <InboxView />
    </Suspense>
  );
}
