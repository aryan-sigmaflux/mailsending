import { Suspense } from "react";
import { Skeleton } from "@/components/ui";
import SequenceBuilder from "./SequenceBuilder";

export default function Page() {
  return (
    <Suspense fallback={<Skeleton h={600} />}>
      <SequenceBuilder />
    </Suspense>
  );
}
