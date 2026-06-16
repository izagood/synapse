// 이모지 대신 쓰는 가벼운 인라인 SVG 아이콘 (Obsidian/VS Code 스타일, stroke 기반)
import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 16, children, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const ChevronIcon = (p: IconProps) => (
  <Svg {...p}>
    <polyline points="6 4 10 8 6 12" />
  </Svg>
);

export const FileTextIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9 1.5H4.5A1 1 0 0 0 3.5 2.5v11a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V5z" />
    <path d="M9 1.5V5h3.5" />
    <line x1="5.8" y1="8.5" x2="10.2" y2="8.5" />
    <line x1="5.8" y1="11" x2="10.2" y2="11" />
  </Svg>
);

// 연필(드로잉/Excalidraw 파일용)
export const PencilIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M11 2.5l2.5 2.5L6 12.5l-3 .5.5-3z" />
    <line x1="9.5" y1="4" x2="12" y2="6.5" />
  </Svg>
);

export const GraphIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="3.5" cy="12" r="1.8" />
    <circle cx="12.5" cy="11.5" r="1.8" />
    <circle cx="8" cy="3.5" r="1.8" />
    <line x1="7" y1="4.7" x2="4.5" y2="10.3" />
    <line x1="9" y1="4.7" x2="11.5" y2="10" />
    <line x1="5.3" y1="12" x2="10.7" y2="11.6" />
  </Svg>
);

export const GlobeIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="6" />
    <path d="M2 8h12" />
    <path d="M8 2c1.8 1.8 1.8 10.2 0 12-1.8-1.8-1.8-10.2 0-12z" />
  </Svg>
);

export const FileIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9 1.5H4.5A1 1 0 0 0 3.5 2.5v11a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V5z" />
    <path d="M9 1.5V5h3.5" />
  </Svg>
);

export const FilePdfIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9 1.5H4.5A1 1 0 0 0 3.5 2.5v11a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V5z" />
    <path d="M9 1.5V5h3.5" />
    <path d="M5.6 11.6c2-0.4 3-2 3.6-3.7 0.4-1.2 0.2-2-0.4-2-0.7 0-0.9 0.9-0.5 2.2 0.5 1.6 1.7 2.9 2.9 3" />
  </Svg>
);

export const ImageIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="2" y="3" width="12" height="10" rx="1" />
    <circle cx="5.5" cy="6.5" r="1.2" />
    <path d="M3 12l3.5-3.5 2.5 2.5 2-2L14 11.5" />
  </Svg>
);

export const DiagramIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="2" y="2.5" width="5" height="4" rx="0.6" />
    <rect x="9" y="9.5" width="5" height="4" rx="0.6" />
    <path d="M4.5 6.5v3a1 1 0 0 0 1 1H9" />
  </Svg>
);

export const PlusIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 3.5v9M3.5 8h9" />
  </Svg>
);

export const MinusIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.5 8h9" />
  </Svg>
);

export const RefreshIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M13 8a5 5 0 1 1-1.7-3.75" />
    <polyline points="13 2.5 13 5.5 10 5.5" />
  </Svg>
);

export const GearIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="2.4" />
    <path d="M8 1.6v2M8 12.4v2M1.6 8h2M12.4 8h2M3.5 3.5l1.4 1.4M11.1 11.1l1.4 1.4M12.5 3.5l-1.4 1.4M4.9 11.1l-1.4 1.4" />
  </Svg>
);

export const FolderIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2 4a1 1 0 0 1 1-1h3.2L7.8 4.6H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z" />
  </Svg>
);

export const HomeIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 7.3 8 3l5 4.3V13a.8.8 0 0 1-.8.8H3.8A.8.8 0 0 1 3 13z" />
    <path d="M6.5 13.8V9.8h3v4" />
  </Svg>
);

export const SearchIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="7" cy="7" r="4.4" />
    <path d="m10.4 10.4 3.1 3.1" />
  </Svg>
);

// 전체 검색(Find in Files): 텍스트 줄 위의 돋보기
export const SearchTextIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2.5 3.5h11M2.5 6.5h7M2.5 9.5h4" />
    <circle cx="9.5" cy="10.5" r="3" />
    <path d="m11.7 12.7 2 2" />
  </Svg>
);

export const CodeIcon = (p: IconProps) => (
  <Svg {...p}>
    <polyline points="5.5 5 2.5 8 5.5 11" />
    <polyline points="10.5 5 13.5 8 10.5 11" />
  </Svg>
);

export const CloseIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="m4.2 4.2 7.6 7.6M11.8 4.2l-7.6 7.6" />
  </Svg>
);

export const CheckIcon = (p: IconProps) => (
  <Svg {...p}>
    <polyline points="3 8.5 6.5 12 13 4.5" />
  </Svg>
);

export const AlertIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 2.2 1.7 13h12.6z" />
    <line x1="8" y1="6.5" x2="8" y2="9.5" />
    <circle cx="8" cy="11.3" r="0.4" fill="currentColor" stroke="none" />
  </Svg>
);

export const LogOutIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 14H3.5A1.5 1.5 0 0 1 2 12.5v-9A1.5 1.5 0 0 1 3.5 2H6" />
    <path d="m10.5 11 3-3-3-3" />
    <path d="M13.5 8H6.5" />
  </Svg>
);

export const SidebarIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="2" y="3" width="12" height="10" rx="1" />
    <line x1="6" y1="3" x2="6" y2="13" />
  </Svg>
);

export const NewWindowIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="2" y="3" width="9" height="8" rx="1" />
    <path d="M12 6.5h2M13 5.5v2" />
    <path d="M5 13h6.5A1.5 1.5 0 0 0 13 11.5V10" />
  </Svg>
);

export const SparkleIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 1.8 9.6 6.4 14.2 8 9.6 9.6 8 14.2 6.4 9.6 1.8 8 6.4 6.4z" />
  </Svg>
);

export const SendIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M14 2 7.3 8.7" />
    <path d="M14 2 9.7 14l-2.4-5.3L2 6.3z" />
  </Svg>
);

export const StopIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="4" y="4" width="8" height="8" rx="1.2" fill="currentColor" stroke="none" />
  </Svg>
);

export const GitHubIcon = (p: IconProps) => (
  <Svg {...p}>
    <path
      d="M8 1.6a6.4 6.4 0 0 0-2 12.46c.32.06.43-.14.43-.3v-1.2c-1.78.38-2.15-.76-2.15-.76-.3-.74-.71-.94-.71-.94-.58-.4.04-.39.04-.39.64.05.98.66.98.66.57.97 1.5.69 1.86.53.06-.41.22-.7.4-.85-1.42-.16-2.91-.71-2.91-3.16 0-.7.25-1.27.66-1.72-.07-.16-.29-.81.06-1.7 0 0 .54-.17 1.76.66a6.1 6.1 0 0 1 3.2 0c1.22-.83 1.76-.66 1.76-.66.35.89.13 1.54.06 1.7.41.45.66 1.02.66 1.72 0 2.46-1.5 3-2.92 3.15.23.2.43.58.43 1.18v1.75c0 .17.11.37.44.3A6.4 6.4 0 0 0 8 1.6z"
      fill="currentColor"
      stroke="none"
    />
  </Svg>
);
