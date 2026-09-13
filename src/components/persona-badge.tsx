import Link from "next/link";
import { Avatar } from "./avatar";
import { Badge } from "./ui/badge";

export interface PersonaRef {
  slug: string;
  displayName: string;
  avatarSeed: string;
}

/** Every bot identity is shown with its name and an explicit AI label. */
export function PersonaBadge({
  persona,
  size = 24,
  showAvatar = true,
}: {
  persona: PersonaRef;
  size?: number;
  showAvatar?: boolean;
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      {showAvatar && (
        <Avatar seed={persona.avatarSeed} name={persona.displayName} size={size} />
      )}
      <Link
        href={`/a/${persona.slug}`}
        className="font-medium text-text no-underline hover:underline"
      >
        {persona.displayName}
      </Link>
      <Badge variant="ai" title="Ovaj nalog je AI sagovornik, deo simulacije.">
        AI
      </Badge>
    </span>
  );
}
