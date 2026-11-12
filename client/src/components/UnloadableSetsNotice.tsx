import type { UnloadableSetsVM } from "@toefl-prep/shared";
import { InternalName } from "../ui/Disclosure";
import { Notice } from "../ui/Notice";

// The server's listing skips a Set file that fails schema validation rather than failing the whole
// bank, which from the browser looks exactly like the Set never existing. This says that it did,
// which file it is and which field broke — what it takes to go and fix it on disk.
//
// Renders nothing when the bank is healthy, and nothing when the probe itself failed (`null`): a
// diagnostic that cannot load must not put a warning over Sets that loaded perfectly well.
export default function UnloadableSetsNotice({ unloadable }: { unloadable: UnloadableSetsVM | null }) {
  if (!unloadable || unloadable.count === 0) return null;

  return (
    <Notice tone="caution" title={`${unloadable.count} ${unloadable.count === 1 ? "Set" : "Sets"} on disk could not be loaded`}>
      <p>They failed validation, so they are missing from every list and picker. The rest of the bank is unaffected.</p>
      <ul className="mt-2 space-y-1.5 text-meta">
        {/* Keyed by the file's own path, which is unique per directory entry by definition. */}
        {unloadable.failures.map((failure) => (
          <li key={`${failure.kind}/${failure.file}`} className="wrap-anywhere">
            <InternalName>
              data/question-sets/{failure.kind}/{failure.file}
            </InternalName>{" "}
            {failure.error}
          </li>
        ))}
      </ul>
    </Notice>
  );
}
