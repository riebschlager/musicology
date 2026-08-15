export interface NavigationItem {
  readonly href: string;
  readonly label: string;
  readonly shortLabel: string;
}

export const PRIMARY_NAVIGATION: readonly NavigationItem[] = [
  { href: "/", label: "Long view", shortLabel: "01" },
  { href: "/history/", label: "History & coverage", shortLabel: "02" },
  { href: "/artists/", label: "Artists", shortLabel: "03" },
  { href: "/stories/", label: "Stories", shortLabel: "04" },
  { href: "/explore/", label: "Explore", shortLabel: "05" },
  { href: "/methodology/", label: "Methodology", shortLabel: "06" },
];
