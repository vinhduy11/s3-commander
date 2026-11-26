// Pure helpers over operation locations (a local directory or a bucket prefix) for drop rules.

import type { Location } from "../ops/ops_api";

/** The folder `name` inside a directory location. */
export function childLocation(location: Location, name: string): Location {
  if (location.kind === "bucket") return { ...location, prefix: `${location.prefix}${name}/` };
  return { kind: "local", path: location.path === "/" ? `/${name}` : `${location.path}/${name}` };
}

const trimSlash = (path: string) => (path.length > 1 ? path.replace(/\/+$/, "") : path);

export function sameLocation(first: Location, second: Location): boolean {
  if (first.kind === "bucket" && second.kind === "bucket") return first.bucket === second.bucket && first.prefix === second.prefix;
  return first.kind === "local" && second.kind === "local" && trimSlash(first.path) === trimSlash(second.path);
}

/** True when `dest` is the folder `name` of `source`, or somewhere below it. */
export function isInside(source: Location, name: string, dest: Location): boolean {
  const folder = childLocation(source, name);
  if (folder.kind === "bucket" && dest.kind === "bucket") return folder.bucket === dest.bucket && dest.prefix.startsWith(folder.prefix);
  if (folder.kind === "local" && dest.kind === "local") return dest.path === folder.path || dest.path.startsWith(`${folder.path}/`);
  return false;
}
