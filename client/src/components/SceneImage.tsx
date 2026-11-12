import { useState } from "react";
import type { FocusRegion } from "@toefl-prep/shared";
import { cx } from "../ui/cx";

type SceneImageProps = {
  file: string;
  focusRegions?: readonly (FocusRegion | undefined)[];
  currentIndex?: number;
  className?: string;
};

/**
 * A served Listen and Repeat scene with an optional Item-specific focus frame: an accent outline
 * around the part of the picture the current sentence is about, moving from Item to Item. The image
 * owns its load/error fallback, so a missing illustration never interferes with the run around it —
 * it simply is not drawn.
 */
export default function SceneImage({ file, focusRegions, currentIndex, className }: SceneImageProps) {
  const [loadedFile, setLoadedFile] = useState<string | null>(null);
  const [failedFile, setFailedFile] = useState<string | null>(null);

  if (failedFile === file) return null;

  const loaded = loadedFile === file;
  const region =
    typeof currentIndex === "number" &&
    Number.isInteger(currentIndex) &&
    currentIndex >= 0 &&
    currentIndex < (focusRegions?.length ?? 0)
      ? focusRegions?.[currentIndex]
      : undefined;

  return (
    <figure
      className={cx(
        "relative mx-auto aspect-square w-full max-w-[30rem] overflow-hidden rounded-sheet border border-rule bg-well",
        loaded ? "visible" : "invisible",
        className,
      )}
    >
      <img
        src={`/api/${file}`}
        alt="Scene illustration"
        className="h-full w-full object-contain"
        onLoad={() => {
          setFailedFile(null);
          setLoadedFile(file);
        }}
        onError={() => {
          setLoadedFile(null);
          setFailedFile(file);
        }}
      />
      {loaded && region && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute rounded-sheet border-2 border-accent outline-2 outline-on-accent/70 transition-[left,top,width,height] duration-500 ease-quiet"
          style={{
            left: `${region.x * 100}%`,
            top: `${region.y * 100}%`,
            width: `${region.w * 100}%`,
            height: `${region.h * 100}%`,
          }}
        />
      )}
    </figure>
  );
}
