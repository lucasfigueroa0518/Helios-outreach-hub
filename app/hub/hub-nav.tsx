'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

import { HUB_TAB_PREFETCH, prefetchHubJson } from '@/app/hub/hub-data';

const TABS = [
  { id: 'campaigns', label: 'Campaigns', href: '/hub' },
  { id: 'queue', label: 'Queue', href: '/hub/queue' },
  { id: 'analytics', label: 'Analytics', href: '/hub/analytics' },
  { id: 'conversations', label: 'Conversations', href: '/hub/conversations' },
] as const;

type TabId = (typeof TABS)[number]['id'];

function tabIdFromPath(pathname: string): TabId {
  if (pathname.startsWith('/hub/queue')) return 'queue';
  if (pathname.startsWith('/hub/analytics')) return 'analytics';
  if (pathname.startsWith('/hub/conversations')) return 'conversations';
  return 'campaigns';
}

function prefetchTab(tab: (typeof TABS)[number], router: ReturnType<typeof useRouter>) {
  router.prefetch(tab.href);
  for (const url of HUB_TAB_PREFETCH[tab.id] ?? []) {
    prefetchHubJson(url);
  }
}

export function HubNav() {
  const pathname = usePathname() || '/hub';
  const router = useRouter();
  const routeTab = tabIdFromPath(pathname);
  const [activeId, setActiveId] = useState<TabId>(routeTab);
  const trackRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [thumb, setThumb] = useState({ left: 0, width: 0, ready: false });

  useEffect(() => {
    setActiveId(routeTab);
  }, [routeTab]);

  // Prefetch RSC routes only on mount — do NOT fan out all hub API calls
  // (that was exhausting Supabase session pool_size ≈ 15).
  useEffect(() => {
    for (const tab of TABS) router.prefetch(tab.href);
  }, [router]);

  const measure = useCallback(() => {
    const track = trackRef.current;
    const index = TABS.findIndex((tab) => tab.id === activeId);
    const item = itemRefs.current[index];
    if (!track || !item) return;
    const trackRect = track.getBoundingClientRect();
    const itemRect = item.getBoundingClientRect();
    setThumb({
      left: itemRect.left - trackRect.left,
      width: itemRect.width,
      ready: true,
    });
  }, [activeId]);

  useLayoutEffect(() => {
    measure();
  }, [measure]);

  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    const observer = new ResizeObserver(() => measure());
    observer.observe(track);
    for (const item of itemRefs.current) {
      if (item) observer.observe(item);
    }
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [measure]);

  function goTo(tab: (typeof TABS)[number]) {
    if (tab.id === activeId && tab.href === pathname) return;
    setActiveId(tab.id);
    router.push(tab.href);
  }

  return (
    <div className="hub-nav-row">
      <Link href="/" className="hub-nav-home" aria-label="Back to Helios products">
        <span className="hub-nav-home__brand">Helios</span>
        <span className="hub-nav-home__product">Outreach</span>
      </Link>
      <nav className="hub-nav-row__tabs" aria-label="Outreach Hub sections">
        <div ref={trackRef} className="segmented hub-nav" role="tablist">
          <span
            className={`hub-nav__thumb${thumb.ready ? ' hub-nav__thumb--ready' : ''}`}
            aria-hidden="true"
            style={{
              width: thumb.width,
              transform: `translateX(${thumb.left}px)`,
            }}
          />
          {TABS.map((tab, index) => {
            const selected = tab.id === activeId;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={selected}
                className={`hub-nav__item${selected ? ' hub-nav__item--active' : ''}`}
                ref={(node) => {
                  itemRefs.current[index] = node;
                }}
                onMouseEnter={() => prefetchTab(tab, router)}
                onFocus={() => prefetchTab(tab, router)}
                onClick={() => goTo(tab)}
              >
                {tab.label}
              </button>
            );
          })}
        </div>
      </nav>
      <span className="hub-nav-row__balance" aria-hidden="true" />
    </div>
  );
}
