import { Modal, type ModalProps } from './modal.js';

export interface SheetProps extends ModalProps {
  /** `auto` docks to the right from the lg breakpoint and to the bottom below it. */
  side?: 'right' | 'bottom' | 'auto' | undefined;
}

const SURFACES = {
  right: 'fixed m-0 overflow-y-auto inset-y-0 right-0 left-auto h-dvh max-h-none w-full max-w-sm',
  bottom:
    'fixed m-0 overflow-y-auto inset-x-0 bottom-0 top-auto max-h-[85dvh] w-full max-w-none rounded-t-2xl',
  auto: [
    'fixed m-0 overflow-y-auto',
    'max-lg:inset-x-0 max-lg:bottom-0 max-lg:top-auto max-lg:max-h-[85dvh] max-lg:w-full max-lg:max-w-none max-lg:rounded-t-2xl',
    'lg:inset-y-0 lg:right-0 lg:left-auto lg:h-dvh lg:max-h-none lg:w-full lg:max-w-sm',
  ].join(' '),
};

const SAFE_AREA = {
  right: undefined,
  bottom: 'pb-[max(1.25rem,env(safe-area-inset-bottom))]',
  auto: 'max-lg:pb-[max(1.25rem,env(safe-area-inset-bottom))]',
};

export function Sheet({ side = 'auto', ...props }: SheetProps) {
  return (
    <Modal
      {...props}
      side={side}
      surfaceClassName={SURFACES[side]}
      contentClassName={SAFE_AREA[side]}
    />
  );
}
