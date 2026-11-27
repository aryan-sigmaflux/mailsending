import { Suspense } from "react";
import { Skeleton } from "@/components/ui";
import ContactsView from "./ContactsView";

export default function Page() {
  return (
    <Suspense fallback={<Skeleton h={480} />}>
      <ContactsView />
    </Suspense>
  );
}
