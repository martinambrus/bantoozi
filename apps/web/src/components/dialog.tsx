import { Modal, type ModalProps } from './modal.js';

export type DialogProps = ModalProps;

export function Dialog(props: DialogProps) {
  return <Modal {...props} surfaceClassName="m-auto w-full max-w-lg rounded-xl" />;
}
