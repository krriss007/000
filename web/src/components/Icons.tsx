import React from 'react';

type Props = { size?: number; className?: string };

const base = (size: number) => ({
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
  focusable: false,
});

export const SearchIcon = ({ size = 16, className }: Props) => (
  <svg {...base(size)} className={className}>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </svg>
);

export const CloseIcon = ({ size = 16, className }: Props) => (
  <svg {...base(size)} className={className}>
    <path d="M18 6 6 18M6 6l12 12" />
  </svg>
);

export const ChevronLeft = ({ size = 20, className }: Props) => (
  <svg {...base(size)} className={className}>
    <path d="m15 18-6-6 6-6" />
  </svg>
);

export const ChevronRight = ({ size = 20, className }: Props) => (
  <svg {...base(size)} className={className}>
    <path d="m9 18 6-6-6-6" />
  </svg>
);

export const RefreshIcon = ({ size = 16, className }: Props) => (
  <svg {...base(size)} className={className}>
    <path d="M21 12a9 9 0 1 1-3.2-6.9" />
    <path d="M21 3v6h-6" />
  </svg>
);

export const InfoIcon = ({ size = 18, className }: Props) => (
  <svg {...base(size)} className={className}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5M12 8h.01" />
  </svg>
);

export const AlertIcon = ({ size = 18, className }: Props) => (
  <svg {...base(size)} className={className}>
    <path d="M12 3.8 2.7 20h18.6L12 3.8Z" />
    <path d="M12 9v4.5M12 17h.01" />
  </svg>
);

export const CheckIcon = ({ size = 18, className }: Props) => (
  <svg {...base(size)} className={className}>
    <path d="m4 12.5 5 5 11-11" />
  </svg>
);

export const ExternalIcon = ({ size = 15, className }: Props) => (
  <svg {...base(size)} className={className}>
    <path d="M14 4h6v6" />
    <path d="M20 4 11 13" />
    <path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5" />
  </svg>
);

export const UserIcon = ({ size = 16, className }: Props) => (
  <svg {...base(size)} className={className}>
    <circle cx="12" cy="8.5" r="3.6" />
    <path d="M4.5 20a7.5 7.5 0 0 1 15 0" />
  </svg>
);

export const StarIcon = ({ size = 13, className }: Props) => (
  <svg {...base(size)} className={className} fill="currentColor" stroke="none">
    <path d="m12 3.6 2.6 5.4 5.9.8-4.3 4.1 1 5.9-5.2-2.8-5.2 2.8 1-5.9L3.5 9.8l5.9-.8L12 3.6Z" />
  </svg>
);

export const FilmIcon = ({ size = 16, className }: Props) => (
  <svg {...base(size)} className={className}>
    <rect x="3" y="4" width="18" height="16" rx="2.5" />
    <path d="M8 4v16M16 4v16M3 12h18" />
  </svg>
);

export const TvIcon = ({ size = 16, className }: Props) => (
  <svg {...base(size)} className={className}>
    <rect x="2.5" y="6" width="19" height="13" rx="2.5" />
    <path d="m8 3 4 3 4-3" />
  </svg>
);

export const ClockIcon = ({ size = 16, className }: Props) => (
  <svg {...base(size)} className={className}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 2" />
  </svg>
);

export const DatabaseIcon = ({ size = 16, className }: Props) => (
  <svg {...base(size)} className={className}>
    <ellipse cx="12" cy="6" rx="8" ry="3" />
    <path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6" />
    <path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
  </svg>
);

export const CompassIcon = ({ size = 16, className }: Props) => (
  <svg {...base(size)} className={className}>
    <circle cx="12" cy="12" r="9" />
    <path d="m15.5 8.5-2 5-5 2 2-5 5-2Z" />
  </svg>
);

export const BoxIcon = ({ size = 16, className }: Props) => (
  <svg {...base(size)} className={className}>
    <path d="M3.5 7.5 12 3l8.5 4.5v9L12 21l-8.5-4.5v-9Z" />
    <path d="M3.5 7.5 12 12l8.5-4.5M12 12v9" />
  </svg>
);

export const SparkIcon = ({ size = 16, className }: Props) => (
  <svg {...base(size)} className={className}>
    <path d="M12 3v4M12 17v4M3 12h4M17 12h4M6.3 6.3l2.8 2.8M14.9 14.9l2.8 2.8M17.7 6.3l-2.8 2.8M9.1 14.9l-2.8 2.8" />
  </svg>
);
