'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Menu, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';

const PRODUCTS = [
  { href: '/hub', label: 'Outreach', match: (path: string) => path.startsWith('/hub') || path.startsWith('/campaigns') },
  { href: '/dashboards', label: 'Project Dashboards', match: (path: string) => path.startsWith('/dashboards') },
] as const;

export function SiteProductMenu() {
  const pathname = usePathname() || '/';
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }
    window.addEventListener('mousedown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div className="site-product-menu" ref={rootRef}>
      <button
        type="button"
        className={`site-product-menu__trigger${open ? ' is-open' : ''}`}
        aria-label={open ? 'Close product menu' : 'Open product menu'}
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? <X size={18} strokeWidth={2.25} aria-hidden="true" /> : <Menu size={18} strokeWidth={2.25} aria-hidden="true" />}
      </button>

      <div
        id={menuId}
        className={`site-product-menu__panel${open ? ' is-open' : ''}`}
        role="menu"
        aria-label="Helios products"
        aria-hidden={!open}
        inert={!open ? true : undefined}
      >
        <p className="site-product-menu__eyebrow">Helios</p>
        <div className="site-product-menu__list">
          {PRODUCTS.map((product) => {
            const active = product.match(pathname);
            return (
              <Link
                key={product.href}
                href={product.href}
                role="menuitem"
                className={`site-product-menu__item${active ? ' is-active' : ''}`}
                aria-current={active ? 'page' : undefined}
                tabIndex={open ? 0 : -1}
                onClick={() => setOpen(false)}
              >
                {product.label}
              </Link>
            );
          })}
        </div>
      </div>
    </div>
  );
}
