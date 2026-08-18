import { db } from "@/db";
import { listRecentTakeOuts } from "@/db/queries/movements";
import { requireUser } from "@/lib/auth";
import { SearchScreen } from "./search-screen";

export const metadata = { title: "Search · LabStock" };

export default async function HomePage() {
  const user = await requireUser();

  // Fetched here rather than inside the client screen so the idle state is
  // already drawn when the page arrives: the person is standing at a cupboard,
  // and a list that appears a moment later is a list they have already scrolled
  // past.
  const recent = await listRecentTakeOuts(db, user.id);

  return <SearchScreen recent={recent} />;
}
