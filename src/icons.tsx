// Inline SVG icons (stroke, currentColor). No icon font, no network.
import type { ReactNode } from "react";

const BASE = { width: 14, height: 14, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true, focusable: false } as const;

const Svg = ({ children, size = 14 }: { children: ReactNode; size?: number }) => (
  <svg {...BASE} width={size} height={size}>{children}</svg>
);

const sheet = <path d="M4 1.7h5.3L12.5 5v9.3H4z M9.3 1.7V5h3.2" />;

export const FolderIcon = () => <Svg><path d="M1.7 4.2a1 1 0 0 1 1-1h3.1l1.4 1.6h6.1a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1H2.7a1 1 0 0 1-1-1z" fill="currentColor" fillOpacity=".18" /></Svg>;
export const UpIcon = () => <Svg><path d="M8 13V3.5M3.8 7.4 8 3.2l4.2 4.2" /></Svg>;
export const LockIcon = () => <Svg><rect x="3" y="7" width="10" height="7" rx="1.5" /><path d="M5.3 7V5a2.7 2.7 0 0 1 5.4 0v2" /></Svg>;
export const KeyIcon = ({ size = 28 }: { size?: number }) => <Svg size={size}><circle cx="5.5" cy="10.5" r="2.8" /><path d="M7.6 8.6 13.5 2.7M11 5.2l1.8 1.8" /></Svg>;
export const ChevronIcon = ({ open }: { open: boolean }) => <Svg><path d={open ? "M3.5 6 8 10.5 12.5 6" : "M6 3.5 10.5 8 6 12.5"} /></Svg>;
export const ServerIcon = () => <Svg><rect x="2" y="2.5" width="12" height="4.5" rx="1" /><rect x="2" y="9" width="12" height="4.5" rx="1" /><path d="M4.6 4.8h.01M4.6 11.3h.01" /></Svg>;
export const DiskIcon = () => <Svg><rect x="2" y="3" width="12" height="9" rx="1.5" /><path d="M5 14.5h6M8 12v2.5" /></Svg>;
export const UsersIcon = () => <Svg><circle cx="8" cy="5.5" r="2.5" /><path d="M3 13.5c.4-2.6 2.5-4 5-4s4.6 1.4 5 4" /></Svg>;

type Kind = "image" | "archive" | "code" | "media" | "doc" | "file";
const EXT: Record<Kind, string[]> = {
  image: ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "tif", "tiff", "heic"],
  archive: ["zip", "tar", "gz", "tgz", "bz2", "xz", "7z", "rar", "jar", "zst"],
  code: ["js", "ts", "tsx", "jsx", "go", "rs", "py", "java", "c", "h", "cpp", "sh", "json", "yaml", "yml", "toml", "html", "css", "sql", "xml", "env"],
  media: ["mp3", "wav", "flac", "ogg", "mp4", "mkv", "mov", "avi", "webm"],
  doc: ["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "md", "csv", "log", "rtf"],
  file: [],
};
const kindOf = (ext: string): Kind =>
  (Object.keys(EXT) as Kind[]).find((kind) => EXT[kind].includes(ext.toLowerCase().replace(/^\./, ""))) ?? "file";

/** Folder, parent-dir arrow, or a file glyph tinted by file type. */
export function EntryIcon({ isDir, isUp, ext }: { isDir: boolean; isUp: boolean; ext: string }) {
  if (isUp) return <span className="ico ico-up"><UpIcon /></span>;
  if (isDir) return <span className="ico ico-dir"><FolderIcon /></span>;
  const kind = kindOf(ext);
  return (
    <span className={`ico ico-${kind}`}>
      <Svg>
        {sheet}
        {kind === "image" && <path d="m5.6 11.6 2-2.4 1.4 1.6 1.2-1.2 1.2 2" />}
        {kind === "archive" && <path d="M8 3v1.6M8 6v1.6M8 9v1.6" />}
        {kind === "code" && <path d="m7 7.2-1.5 1.6L7 10.4M9.6 7.2l1.5 1.6-1.5 1.6" />}
        {kind === "media" && <path d="M7 7.3v3.4l2.8-1.7z" />}
        {kind === "doc" && <path d="M6 8h4.5M6 10h4.5M6 12h2.5" />}
      </Svg>
    </span>
  );
}
