// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type Dispatch,
  type JSX,
  type MutableRefObject,
  type SetStateAction,
} from 'react';
import { useSelector } from 'react-redux';
import classNames from 'classnames';
import { v4 as generateUuid } from 'uuid';
import { ChatsTab } from '../../components/ChatsTab.dom.tsx';
import {
  CompositionInput,
  type InputApi,
} from '../../components/CompositionInput.dom.tsx';
import { CompositionRecording } from '../../components/CompositionRecording.dom.tsx';
import { AudioCapture } from '../../components/conversation/AudioCapture.dom.tsx';
import { AttachmentList } from '../../components/conversation/AttachmentList.dom.tsx';
import { ConversationView } from '../../components/conversation/ConversationView.dom.tsx';
import { useContactNameData } from '../../components/conversation/ContactName.dom.tsx';
import { MessageRequestActions } from '../../components/conversation/MessageRequestActions.dom.tsx';
import { DialogRelink } from '../../components/DialogRelink.dom.tsx';
import { Quote } from '../../components/conversation/Quote.dom.tsx';
import SelectModeActions from '../../components/conversation/SelectModeActions.dom.tsx';
import { ForwardMessagesModalType } from '../../components/ForwardMessagesModal.dom.tsx';
import { MediaEditor } from '../../components/MediaEditor.dom.tsx';
import { FunPickerButton } from '../../components/fun/FunButton.dom.tsx';
import { FunPicker } from '../../components/fun/FunPicker.dom.tsx';
import type { FunEmojiSelection } from '../../components/fun/panels/FunPanelEmojis.dom.tsx';
import type { FunStickerSelection } from '../../components/fun/panels/FunPanelStickers.dom.tsx';
import type { NavTabPanelProps } from '../../components/NavTabs.dom.tsx';
import type { WidthBreakpoint } from '../../components/_util.std.ts';
import { AxoDropdownMenu } from '../../axo/AxoDropdownMenu.dom.tsx';
import { AxoIconButton } from '../../axo/AxoIconButton.dom.tsx';
import type { DraftEditMessageType } from '../../model-types.d.ts';
import {
  sendDirectEditMessage,
  sendDirectTextMessage,
  sendGroupTextMessage,
  uploadMessageAttachment,
} from '../api.dom.ts';
import { persistChatShellStateToStorage } from '../persistence.dom.ts';
import type {
  ChatShellState,
  LinkedSessionRecord,
  WebAttachment,
  WebMessage,
} from '../types.std.ts';
import {
  getIntl,
  getPlatform,
  getTheme,
  getUserConversationId,
} from '../../state/selectors/user.std.ts';
import {
  getDefaultConversationColor,
  getNavTabsCollapsed,
  getTextFormattingEnabled,
} from '../../state/selectors/items.dom.ts';
import { getPreferredBadgeSelector } from '../../state/selectors/badges.preload.ts';
import { getComposerStateForConversationIdSelector } from '../../state/selectors/composer.preload.ts';
import {
  getConversationSelector,
  getLeftPaneLists,
  getMessages,
  getOtherTabsUnreadStats,
  getSelectedMessageIds,
  getTargetedMessage,
  getTargetedMessageSource,
} from '../../state/selectors/conversations.dom.ts';
import {
  canForward,
  getPropsForQuote,
} from '../../state/selectors/message.preload.ts';
import {
  getActivePanel,
  getIsPanelAnimating,
  getSelectedConversationId,
} from '../../state/selectors/nav.std.ts';
import { isShowingAnyModal } from '../../state/selectors/globalModals.std.ts';
import { useConversationsActions } from '../../state/ducks/conversations.preload.ts';
import { useComposerActions } from '../../state/ducks/composer.preload.ts';
import { useGlobalModalActions } from '../../state/ducks/globalModals.preload.ts';
import { useItemsActions } from '../../state/ducks/items.preload.ts';
import { useToastActions } from '../../state/ducks/toast.preload.ts';
import { TargetedMessageSource } from '../../state/ducks/conversationsEnums.std.ts';
import { SmartLeftPane } from '../../state/smart/LeftPane.preload.tsx';
import { SmartConversationHeader } from '../../state/smart/ConversationHeader.preload.tsx';
import { ConversationPanel } from '../../state/smart/ConversationPanel.preload.tsx';
import { SmartTimeline } from '../../state/smart/Timeline.preload.tsx';
import type { PeakType } from '../../types/Audio.dom.tsx';
import { ToastType } from '../../types/Toast.dom.tsx';
import { AUDIO_MPEG, IMAGE_JPEG, IMAGE_PNG } from '../../types/MIME.std.ts';
import { SignalService as Proto } from '../../protobuf/index.std.ts';
import { AudioRecorder } from '../../services/audioRecorder.dom.ts';
import { getAddedByForGroup } from '../../util/getAddedByForGroup.preload.ts';
import { strictAssert } from '../../util/assert.std.ts';
import { imageToBlurHash } from '../../util/imageToBlurHash.dom.ts';
import { isViewOnceEligible } from '../../util/viewOnceEligibility.std.ts';
import { getSharedGroupNames } from '../../util/sharedGroupNames.dom.ts';
import { getDirectSendAccessKey } from '../directSendAccessKey.dom.ts';
import {
  compareWebMessages,
  getWebConversationLastMessage,
  getWebMessagePreviewText,
  normalizeWebConversationForDesktopSemantics,
  registerMessageInCache,
  toDesktopConversation,
  toDesktopMessage,
} from './stateAdapter.dom.ts';
import { setWebRuntimeChatShell } from './setupWebGlobals.dom.ts';
import { getWebAttachmentContentType } from '../attachmentMime.std.ts';

function arrayBufferToBase64(arrayBuffer: ArrayBuffer): string {
  const bytes = new Uint8Array(arrayBuffer);
  const chunkSize = 0x8000;
  let binary = '';
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function bytesToBase64(bytes: Uint8Array<ArrayBuffer>): string {
  return arrayBufferToBase64(bytes.buffer);
}

function getAttachmentKind(file: File): WebAttachment['kind'] {
  const contentType = getWebAttachmentContentType(file);
  if (contentType.startsWith('image/')) {
    return 'image';
  }
  if (contentType.startsWith('video/')) {
    return 'video';
  }
  return 'file';
}

async function getImageDimensions(
  url: string
): Promise<Pick<WebAttachment, 'width' | 'height'>> {
  return new Promise(resolve => {
    const image = new Image();
    image.onload = () => {
      resolve({
        height: image.naturalHeight,
        width: image.naturalWidth,
      });
    };
    image.onerror = () => {
      resolve({});
    };
    image.src = url;
  });
}

async function blobToUint8Array(blob: Blob): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await blob.arrayBuffer());
}

function canvasToJpegBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise(resolve => {
    canvas.toBlob(resolve, IMAGE_JPEG, 0.92);
  });
}

async function getVideoDraftMetadata(
  file: File,
  url: string
): Promise<
  Pick<WebAttachment, 'thumbnail' | 'thumbnailUrl' | 'width' | 'height'>
> {
  return new Promise(resolve => {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'metadata';
    video.onloadedmetadata = () => {
      const width = video.videoWidth || 320;
      const height = video.videoHeight || 240;
      const capture = async () => {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const context = canvas.getContext('2d');
          if (!context) {
            resolve({ height, width });
            return;
          }
          context.drawImage(video, 0, 0, width, height);
          const blob = await canvasToJpegBlob(canvas);
          if (!blob) {
            resolve({ height, width });
            return;
          }
          const thumbnailUrl = URL.createObjectURL(blob);
          const thumbnailBytes = await blobToUint8Array(blob);
          resolve({
            height,
            thumbnail: {
              id: `draft-video-thumbnail-${Date.now()}-${Math.floor(
                Math.random() * 10000
              )}`,
              clientUuid: generateUuid(),
              contentType: IMAGE_JPEG,
              dataBase64: bytesToBase64(thumbnailBytes),
              fileName: `${file.name}.jpg`,
              kind: 'image',
              path: thumbnailUrl,
              size: blob.size,
              status: 'pending',
              url: thumbnailUrl,
              width,
              height,
            },
            thumbnailUrl,
            width,
          });
        } catch {
          resolve({ height, width });
        }
      };
      video.onseeked = () => {
        void capture();
      };
      try {
        video.currentTime = Math.min(0.1, video.duration || 0);
      } catch {
        void capture();
      }
    };
    video.onerror = () => resolve({});
    video.src = url;
  });
}

async function fileToDraftAttachment(file: File): Promise<WebAttachment> {
  const url = URL.createObjectURL(file);
  const contentType = getWebAttachmentContentType(file);
  const kind = getAttachmentKind(file);
  const mediaMetadata: Pick<
    WebAttachment,
    'height' | 'thumbnail' | 'thumbnailUrl' | 'width'
  > =
    kind === 'image'
      ? await getImageDimensions(url)
      : kind === 'video'
        ? await getVideoDraftMetadata(file, url)
        : {};
  const displayUrl =
    kind === 'video' && mediaMetadata.thumbnailUrl
      ? mediaMetadata.thumbnailUrl
      : url;
  const id = `draft-file-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  return {
    id,
    clientUuid: generateUuid(),
    contentType,
    fileName: kind === 'image' || kind === 'video' ? undefined : file.name,
    kind,
    path: displayUrl,
    previewUrl: kind === 'video' ? url : undefined,
    pending: false,
    size: file.size,
    status: 'pending',
    url: displayUrl,
    ...mediaMetadata,
  } as WebAttachment & { pending: false };
}

function getWebQuoteForSend(
  quotedMessage: ReturnType<
    ReturnType<typeof getComposerStateForConversationIdSelector>
  >['quotedMessage']
): WebMessage['quote'] | undefined {
  if (!quotedMessage?.quote) {
    return undefined;
  }

  return {
    ...quotedMessage.quote,
    type: Proto.DataMessage.Quote.Type.NORMAL,
  } as unknown as WebMessage['quote'];
}

type WebRelinkDialogProps = Readonly<{
  containerWidthBreakpoint: WidthBreakpoint;
  onRelinkDevice: () => void;
}>;

function WebRelinkDialog({
  containerWidthBreakpoint,
  onRelinkDevice,
}: WebRelinkDialogProps): JSX.Element {
  const i18n = useSelector(getIntl);

  return (
    <DialogRelink
      containerWidthBreakpoint={containerWidthBreakpoint}
      i18n={i18n}
      relinkDevice={onRelinkDevice}
      renderClearingDataView={onRelinkDevice}
      reregister={onRelinkDevice}
      weArePrimaryDevice={false}
    />
  );
}

type WebLeftPaneRuntimeContextValue = Readonly<{
  forceRelinkDialog: boolean;
  onRelinkDevice: () => void;
}>;

const WebLeftPaneRuntimeContext =
  createContext<WebLeftPaneRuntimeContextValue | undefined>(undefined);

function useWebLeftPaneRuntimeContext(): WebLeftPaneRuntimeContextValue {
  const context = useContext(WebLeftPaneRuntimeContext);
  strictAssert(context != null, 'WebLeftPaneRuntimeContext must be provided');
  return context;
}

const WebLeftPane = memo(function WebLeftPane(
  props: NavTabPanelProps
): JSX.Element {
  const { forceRelinkDialog, onRelinkDevice } =
    useWebLeftPaneRuntimeContext();
  const { conversations, pinnedConversations } = useSelector(getLeftPaneLists);
  const leftPaneLayoutKey = useMemo(
    () =>
      [
        pinnedConversations.map(conversation => conversation.id).join(','),
        conversations.length,
        pinnedConversations.length > 0 && conversations.length > 0
          ? 'with-chat-header'
          : 'without-chat-header',
      ].join('|'),
    [conversations, pinnedConversations]
  );
  const renderRelinkDialogOverride = useCallback(
    (dialogProps: Omit<WebRelinkDialogProps, 'onRelinkDevice'>) => (
      <WebRelinkDialog
        {...dialogProps}
        onRelinkDevice={onRelinkDevice}
      />
    ),
    [onRelinkDevice]
  );

  return (
    <SmartLeftPane
      key={leftPaneLayoutKey}
      forceRelinkDialog={forceRelinkDialog}
      renderRelinkDialogOverride={renderRelinkDialogOverride}
      {...props}
    />
  );
});

function renderLeftPane(props: NavTabPanelProps): JSX.Element {
  return <WebLeftPane {...props} />;
}

function renderMiniPlayer(): JSX.Element {
  return <></>;
}

function noopShowWhatsNewModal(): undefined {
  return undefined;
}

type WebConversationRuntimeContextValue = Readonly<{
  linkedSession: LinkedSessionRecord;
  messageRuntimeSessionId?: string;
  shellRef: MutableRefObject<ChatShellState>;
  setShell: Dispatch<SetStateAction<ChatShellState>>;
}>;

const WebConversationRuntimeContext =
  createContext<WebConversationRuntimeContextValue | undefined>(undefined);

function useWebConversationRuntimeContext(): WebConversationRuntimeContextValue {
  const context = useContext(WebConversationRuntimeContext);
  strictAssert(
    context != null,
    'WebConversationRuntimeContext must be provided'
  );
  return context;
}

function isWebConversationRenderDebugEnabled(): boolean {
  return Boolean(
    (
      window as typeof window & {
        SignalWebConversationRenderDebug?: boolean;
      }
    ).SignalWebConversationRenderDebug
  );
}

function useWebConversationRenderDebug(
  id: string,
  details: Readonly<Record<string, unknown>>
): void {
  const renderCountRef = useRef(0);
  renderCountRef.current += 1;

  useEffect(() => {
    if (!isWebConversationRenderDebugEnabled()) {
      return;
    }
    console.log('[SignalWebConversationRender]', {
      ...details,
      id,
      renderCount: renderCountRef.current,
    });
  });
}

function WebCompositionArea({
  conversationId,
  linkedSession,
  messageRuntimeSessionId,
  shellRef,
  setShell,
}: Readonly<{
  conversationId: string;
  linkedSession: LinkedSessionRecord;
  messageRuntimeSessionId?: string;
  shellRef: MutableRefObject<ChatShellState>;
  setShell: Dispatch<SetStateAction<ChatShellState>>;
}>): JSX.Element {
  const i18n = useSelector(getIntl);
  const platform = useSelector(getPlatform);
  const theme = useSelector(getTheme);
  const ourConversationId = useSelector(getUserConversationId);
  const getPreferredBadge = useSelector(getPreferredBadgeSelector);
  const isFormattingEnabled = useSelector(getTextFormattingEnabled);
  const conversationSelector = useSelector(getConversationSelector);
  const defaultConversationColor = useSelector(getDefaultConversationColor);
  const selectedMessageIds = useSelector(getSelectedMessageIds);
  const messageLookup = useSelector(getMessages);
  const composerStateForConversationIdSelector = useSelector(
    getComposerStateForConversationIdSelector
  );
  const composerState = composerStateForConversationIdSelector(conversationId);
  const conversation = conversationSelector(conversationId);
  const inputApi = useRef<InputApi | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const mediaInput = useRef<HTMLInputElement | null>(null);
  const pendingAttachmentFilesRef = useRef<Map<string, File>>(new Map());
  const voiceRecorderRef = useRef<AudioRecorder | null>(null);
  const voiceCancelRef = useRef(false);
  const voiceStartedAtRef = useRef(0);
  const voicePeakIndexRef = useRef(0);
  const [draftText, setDraftText] = useState('');
  const [dirty, setDirty] = useState(false);
  const [funPickerOpen, setFunPickerOpen] = useState(false);
  const [large, setLarge] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [isUploadingAttachment, setIsUploadingAttachment] = useState(false);
  const [isRecordingVoiceNote, setIsRecordingVoiceNote] = useState(false);
  const [voicePeaks, setVoicePeaks] = useState<ReadonlyArray<PeakType>>([]);
  const [pendingAttachments, setPendingAttachments] = useState<
    ReadonlyArray<WebAttachment>
  >([]);
  const [isViewOnce, setIsViewOnce] = useState(false);
  const [attachmentToEdit, setAttachmentToEdit] =
    useState<WebAttachment | null>(null);
  const [sendCounter, setSendCounter] = useState(0);
  const editDraftSetRef = useRef<{
    editHistoryLength: number;
    targetMessageId: string;
  } | null>(null);
  const {
    acceptConversation,
    blockAndReportSpam,
    blockConversation,
    deleteConversation,
    discardEditMessage,
    reportSpam,
    scrollToMessage,
    toggleSelectMode,
  } = useConversationsActions();
  const { setQuoteByMessageId } = useComposerActions();
  const { toggleForwardMessagesModal } = useGlobalModalActions();
  const { showToast } = useToastActions();

  const draftEditMessage =
    (conversation.draftEditMessage as DraftEditMessageType | undefined) ?? null;
  const addedBy = useMemo(() => {
    if (conversation.type === 'group') {
      return getAddedByForGroup(conversation);
    }
    return null;
  }, [conversation]);
  const conversationName = useContactNameData(conversation);
  strictAssert(conversationName, 'conversationName is required');
  const addedByName = useContactNameData(addedBy);
  const areSelectedMessagesForwardable = useMemo(() => {
    return selectedMessageIds?.every(messageId => {
      const message = messageLookup[messageId];
      if (!message) {
        return false;
      }
      return canForward(message);
    });
  }, [messageLookup, selectedMessageIds]);
  const quotedMessage = composerState.quotedMessage;
  const quotedMessageId = quotedMessage?.quote?.messageId;
  const showViewOnceToggle = isViewOnceEligible(
    pendingAttachments as never,
    Boolean(quotedMessageId)
  );
  const isViewOnceActive = isViewOnce && showViewOnceToggle;
  const quotedMessageProps = useMemo(() => {
    return quotedMessage
      ? getPropsForQuote(quotedMessage, {
          conversationSelector,
          ourConversationId,
          defaultConversationColor,
          isGroup: conversation.type === 'group',
        })
      : undefined;
  }, [
    conversation.type,
    conversationSelector,
    defaultConversationColor,
    ourConversationId,
    quotedMessage,
  ]);

  const revokePendingAttachmentUrls = useCallback(
    (attachments: ReadonlyArray<WebAttachment>) => {
      const revokeAttachmentUrl = (attachment: WebAttachment): void => {
        if (attachment.id) {
          pendingAttachmentFilesRef.current.delete(attachment.id);
        }
        if (attachment.url?.startsWith('blob:')) {
          URL.revokeObjectURL(attachment.url);
        }
        if (attachment.thumbnailUrl?.startsWith('blob:')) {
          URL.revokeObjectURL(attachment.thumbnailUrl);
        }
        if (attachment.previewUrl?.startsWith('blob:')) {
          URL.revokeObjectURL(attachment.previewUrl);
        }
        if (attachment.thumbnail) {
          revokeAttachmentUrl(attachment.thumbnail);
        }
      };
      attachments.forEach(revokeAttachmentUrl);
    },
    []
  );

  const uploadAttachmentsForSend = useCallback(
    async (
      attachments: ReadonlyArray<WebAttachment>
    ): Promise<ReadonlyArray<WebAttachment>> => {
      const uploadAttachmentForSend = async (
        attachment: WebAttachment
      ): Promise<WebAttachment> => {
        const uploadedThumbnail = attachment.thumbnail
          ? await uploadAttachmentForSend(attachment.thumbnail)
          : undefined;
        const file = attachment.id
          ? pendingAttachmentFilesRef.current.get(attachment.id)
          : undefined;
        const uploadedAttachment = file
          ? await uploadMessageAttachment({
              file,
              runtimeSessionId: messageRuntimeSessionId,
            })
          : undefined;

        return {
          ...attachment,
          ...uploadedAttachment,
          id: uploadedAttachment?.id ?? attachment.id,
          clientUuid: attachment.clientUuid ?? uploadedAttachment?.clientUuid,
          contentType:
            attachment.contentType ?? uploadedAttachment?.contentType,
          fileName:
            attachment.fileName === undefined
              ? uploadedAttachment?.fileName
              : attachment.fileName,
          thumbnail: uploadedThumbnail,
          path: undefined,
          previewUrl: undefined,
          status: uploadedAttachment ? 'ready' : attachment.status,
          thumbnailUrl: undefined,
          url: undefined,
        };
      };

      return Promise.all(attachments.map(uploadAttachmentForSend));
    },
    [messageRuntimeSessionId]
  );

  const resetVoiceRecordingState = useCallback(() => {
    voiceRecorderRef.current = null;
    voiceStartedAtRef.current = 0;
    voicePeakIndexRef.current = 0;
    setVoicePeaks([]);
    setIsRecordingVoiceNote(false);
  }, []);

  useEffect(() => {
    voiceCancelRef.current = true;
    const recorder = voiceRecorderRef.current;
    void recorder?.stop();
    resetVoiceRecordingState();
    inputApi.current?.reset();
    setDraftText('');
    setDirty(false);
    setLarge(false);
    setPendingAttachments(current => {
      revokePendingAttachmentUrls(current);
      return [];
    });
    setIsViewOnce(false);
    setAttachmentToEdit(null);
    setFunPickerOpen(false);
    editDraftSetRef.current = null;
  }, [conversationId, resetVoiceRecordingState, revokePendingAttachmentUrls]);

  useEffect(() => {
    if (!showViewOnceToggle && isViewOnce) {
      setIsViewOnce(false);
    }
  }, [isViewOnce, showViewOnceToggle]);

  useEffect(() => {
    return () => {
      voiceCancelRef.current = true;
      const recorder = voiceRecorderRef.current;
      void recorder?.stop();
      resetVoiceRecordingState();
      setPendingAttachments(current => {
        revokePendingAttachmentUrls(current);
        return [];
      });
    };
  }, [resetVoiceRecordingState, revokePendingAttachmentUrls]);

  useEffect(() => {
    return () => {
      discardEditMessage(conversationId);
    };
  }, [conversationId, discardEditMessage]);

  useEffect(() => {
    if (!draftEditMessage) {
      inputApi.current?.setContents('', undefined, true);
      editDraftSetRef.current = null;
      return;
    }
    if (
      editDraftSetRef.current?.targetMessageId ===
        draftEditMessage.targetMessageId &&
      editDraftSetRef.current?.editHistoryLength ===
        draftEditMessage.editHistoryLength
    ) {
      return;
    }
    inputApi.current?.setContents(draftEditMessage.body, undefined, true);
    setDraftText(draftEditMessage.body);
    setDirty(false);
    editDraftSetRef.current = {
      targetMessageId: draftEditMessage.targetMessageId,
      editHistoryLength: draftEditMessage.editHistoryLength,
    };
  }, [draftEditMessage]);

  const send = useCallback(
    (
      message: string,
      timestamp: number,
      attachmentOverride?: ReadonlyArray<WebAttachment>
    ): boolean => {
      if (isSending) {
        return false;
      }
      const body = message.trim();
      const attachments = attachmentOverride ?? pendingAttachments;
      const credentials = linkedSession.credentials;
      if ((!body && attachments.length === 0) || !credentials) {
        return false;
      }

      const currentShell = shellRef.current;
      const shellConversation = currentShell.conversationLookup[conversationId];
      if (!shellConversation) {
        return false;
      }
      const conversationForSend = normalizeWebConversationForDesktopSemantics(
        shellConversation,
        linkedSession
      );

      setIsSending(true);
      const isEditSubmission = draftEditMessage != null;

      void (async () => {
        try {
          if (draftEditMessage) {
            const updatedAt = Date.now();
            const targetMessage = currentShell.messages.find(
              item => item.id === draftEditMessage.targetMessageId
            );
            if (!targetMessage) {
              throw new Error('Web edit failed: target message was not found');
            }
            if (
              conversationForSend.type === 'group' ||
              conversationForSend.conversationType === 'group'
            ) {
              throw new Error(
                'Web group message edit is not wired to the bridge yet'
              );
            }
            discardEditMessage(conversationId);
            inputApi.current?.reset();
            setDraftText('');
            setDirty(false);
            setSendCounter(current => current + 1);
            const targetTimestamp =
              targetMessage.editMessageTimestamp ?? targetMessage.timestamp;
            setShell(current => {
              const existingMessage = current.messages.find(
                item => item.id === draftEditMessage.targetMessageId
              );
              if (!existingMessage) {
                return current;
              }
              const previousEditHistory = existingMessage.editHistory ?? [];
              const originalMessageHistory =
                previousEditHistory.length === 0
                  ? [
                      {
                        body: existingMessage.body,
                        timestamp: existingMessage.timestamp,
                        received_at:
                          existingMessage.receivedAt ??
                          existingMessage.timestamp,
                        received_at_ms:
                          existingMessage.receivedAt ??
                          existingMessage.timestamp,
                        serverTimestamp: existingMessage.timestamp,
                      },
                    ]
                  : previousEditHistory;
              const updatedMessage: WebMessage = {
                ...existingMessage,
                body,
                editHistory: [
                  {
                    body,
                    timestamp: updatedAt,
                    received_at: updatedAt,
                    received_at_ms: updatedAt,
                    serverTimestamp: updatedAt,
                  },
                  ...originalMessageHistory,
                ],
                editMessageTimestamp: updatedAt,
                editMessageReceivedAt: updatedAt,
                editMessageReceivedAtMs: updatedAt,
                timestamp: existingMessage.timestamp,
              };
              const currentConversation =
                current.conversationLookup[conversationId] ??
                conversationForSend;
              const isNewestInConversation = current.messages.every(item => {
                return (
                  item.conversationId !== conversationId ||
                  item.id === existingMessage.id ||
                  compareWebMessages(item, existingMessage) <= 0
                );
              });
              const nextShell = {
                ...current,
                messages: current.messages.map(item =>
                  item.id === draftEditMessage.targetMessageId
                    ? updatedMessage
                    : item
                ),
                conversationLookup: {
                  ...current.conversationLookup,
                  [conversationId]: {
                    ...currentConversation,
                    draftBodyRanges: undefined,
                    draftEditMessage: undefined,
                    ...(isNewestInConversation
                      ? {
                          lastMessage: getWebConversationLastMessage(
                            updatedMessage,
                            credentials.aci
                          ),
                          lastUpdated: updatedAt,
                          snippet:
                            getWebMessagePreviewText(updatedMessage) ||
                            currentConversation.snippet,
                        }
                      : null),
                  },
                },
              };
              setWebRuntimeChatShell(nextShell);
              void persistChatShellStateToStorage(
                nextShell,
                linkedSession.credentials?.aci
              );
              registerMessageInCache(updatedMessage);
              window.reduxActions?.conversations?.messageChanged?.(
                updatedMessage.id,
                updatedMessage.conversationId,
                toDesktopMessage(updatedMessage)
              );
              const nextConversation =
                nextShell.conversationLookup[conversationId];
              if (nextConversation) {
                window.reduxActions?.conversations?.conversationsUpdated?.([
                  toDesktopConversation(
                    nextConversation,
                    linkedSession
                  ) as never,
                ]);
              }
              return nextShell;
            });
            await sendDirectEditMessage({
              runtimeSessionId: messageRuntimeSessionId,
              accessKey: getDirectSendAccessKey(conversationForSend),
              destinationServiceId:
                conversationForSend.serviceId ?? conversationForSend.id,
              body,
              targetTimestamp,
              timestamp: updatedAt,
            });
            return;
          }

          const isSendTargetGroupConversation =
            conversationForSend.type === 'group' ||
            conversationForSend.conversationType === 'group';
          if (
            isSendTargetGroupConversation &&
            conversationForSend.left === true
          ) {
            showToast({ toastType: ToastType.LeftGroup });
            return;
          }
          const destinationServiceId =
            conversationForSend.serviceId ?? conversationForSend.id;
          const localMessageDestinationId = isSendTargetGroupConversation
            ? (conversationForSend.groupId ?? conversationForSend.id)
            : destinationServiceId;
          const localMessageId = `sent:${localMessageDestinationId}:${timestamp}`;
          const quote = getWebQuoteForSend(quotedMessage);
          const submittedAttachmentIds = new Set(
            attachments.map(attachment => attachment.id).filter(Boolean)
          );
          const optimisticMessage: WebMessage = {
            id: localMessageId,
            attachments,
            body,
            conversationId,
            direction: 'outgoing',
            isViewOnce: isViewOnceActive,
            receivedAt: timestamp,
            sourceServiceId: credentials.aci,
            status: 'queued',
            timestamp,
            quote,
          };

          setShell(current => {
            const currentConversation =
              current.conversationLookup[conversationId] ?? conversationForSend;
            const lastMessage = getWebConversationLastMessage(
              optimisticMessage,
              credentials.aci
            );
            const previewText = getWebMessagePreviewText(optimisticMessage);
            const updatedConversation = {
              ...currentConversation,
              activeAt: timestamp,
              hasMessages: true,
              inboxPosition: timestamp,
              lastMessage,
              lastMessageReceivedAt: timestamp,
              lastMessageReceivedAtMs: timestamp,
              lastUpdated: timestamp,
              messageCount: (currentConversation.messageCount ?? 0) + 1,
              sentMessageCount: (currentConversation.sentMessageCount ?? 0) + 1,
              snippet: previewText || currentConversation.snippet,
              timestamp,
            };
            const nextShell = {
              ...current,
              messages: [
                ...current.messages.filter(item => item.id !== localMessageId),
                optimisticMessage,
              ].sort(compareWebMessages),
              conversationLookup: {
                ...current.conversationLookup,
                [conversationId]: updatedConversation,
              },
            };
            setWebRuntimeChatShell(nextShell);
            void persistChatShellStateToStorage(
              nextShell,
              linkedSession.credentials?.aci
            );
            window.reduxActions?.conversations?.conversationsUpdated?.([
              toDesktopConversation(
                updatedConversation,
                linkedSession
              ) as never,
            ]);
            return nextShell;
          });
          registerMessageInCache(optimisticMessage);
          window.reduxActions?.conversations?.messagesAdded?.({
            conversationId: optimisticMessage.conversationId,
            isActive: document.visibilityState === 'visible',
            isJustSent: true,
            isNewMessage: true,
            messages: [toDesktopMessage(optimisticMessage)],
          });
          inputApi.current?.reset();
          setDraftText('');
          setDirty(false);
          setSendCounter(current => current + 1);
          setIsViewOnce(false);
          if (quotedMessage) {
            setQuoteByMessageId(conversationId, undefined);
          }
          if (!attachmentOverride && submittedAttachmentIds.size > 0) {
            setPendingAttachments(current =>
              current.filter(
                attachment => !submittedAttachmentIds.has(attachment.id)
              )
            );
          }

          const remoteAttachments = await uploadAttachmentsForSend(attachments);

          const sent = isSendTargetGroupConversation
            ? await (async () => {
                return sendGroupTextMessage({
                  attachments: remoteAttachments,
                  runtimeSessionId: messageRuntimeSessionId,
                  groupId: conversationForSend.groupId ?? conversationForSend.id,
                  body,
                  isViewOnce: isViewOnceActive,
                  quote,
                  timestamp,
                  groupV2:
                    conversationForSend.masterKey &&
                    typeof conversationForSend.revision === 'number'
                      ? {
                          masterKey: conversationForSend.masterKey,
                          revision: conversationForSend.revision,
                        }
                      : undefined,
                  groupSendEndorsements:
                    conversationForSend.groupSendEndorsements,
                  recipients: conversationForSend.membersV2?.map(
                    member => member.aci
                  ),
                });
              })()
            : await sendDirectTextMessage({
                attachments: remoteAttachments,
                runtimeSessionId: messageRuntimeSessionId,
                accessKey: getDirectSendAccessKey(conversationForSend),
                destinationServiceId,
                body,
                isViewOnce: isViewOnceActive,
                timestamp,
                quote,
              });

          const normalized: WebMessage = {
            ...sent,
            conversationId,
            body,
            direction: 'outgoing',
            timestamp,
            status: sent.status ?? 'sent',
            attachments: sent.attachments ?? remoteAttachments,
            quote: sent.quote ?? quote,
            isViewOnce: sent.isViewOnce ?? isViewOnceActive,
          };
          let didReplaceLocalMessage = false;
          setShell(current => {
            const currentConversation =
              current.conversationLookup[conversationId] ?? conversationForSend;
            didReplaceLocalMessage = current.messages.some(
              item => item.id === normalized.id
            );
            const lastMessage = getWebConversationLastMessage(
              normalized,
              credentials.aci
            );
            const previewText = getWebMessagePreviewText(normalized);
            const updatedConversation = {
              ...currentConversation,
              activeAt: timestamp,
              hasMessages: true,
              inboxPosition: timestamp,
              lastMessage,
              lastMessageReceivedAt: timestamp,
              lastMessageReceivedAtMs: normalized.receivedAt ?? timestamp,
              lastUpdated: timestamp,
              messageCount:
                (currentConversation.messageCount ?? 0) +
                (didReplaceLocalMessage ? 0 : 1),
              sentMessageCount:
                (currentConversation.sentMessageCount ?? 0) +
                (didReplaceLocalMessage ? 0 : 1),
              snippet: previewText || currentConversation.snippet,
              timestamp,
            };
            const nextShell = {
              ...current,
              messages: [
                ...current.messages.filter(item => item.id !== normalized.id),
                normalized,
              ].sort(compareWebMessages),
              conversationLookup: {
                ...current.conversationLookup,
                [conversationId]: updatedConversation,
              },
            };
            setWebRuntimeChatShell(nextShell);
            void persistChatShellStateToStorage(
              nextShell,
              linkedSession.credentials?.aci
            );
            window.reduxActions?.conversations?.conversationsUpdated?.([
              toDesktopConversation(
                updatedConversation,
                linkedSession
              ) as never,
            ]);
            return nextShell;
          });
          registerMessageInCache(normalized);
          if (didReplaceLocalMessage) {
            window.reduxActions?.conversations?.messageChanged?.(
              normalized.id,
              normalized.conversationId,
              toDesktopMessage(normalized)
            );
          } else {
            window.reduxActions?.conversations?.messagesAdded?.({
              conversationId: normalized.conversationId,
              isActive: document.visibilityState === 'visible',
              isJustSent: true,
              isNewMessage: true,
              messages: [toDesktopMessage(normalized)],
            });
          }
          if (sent.attachments && attachments.length > 0) {
            revokePendingAttachmentUrls(attachments);
          }
          if (!attachmentOverride && submittedAttachmentIds.size > 0) {
            setPendingAttachments(current =>
              current.filter(
                attachment => !submittedAttachmentIds.has(attachment.id)
              )
            );
          }
          setIsViewOnce(false);
          setDirty(false);
        } catch (error) {
          if (isEditSubmission) {
            console.error('Failed to send web edit message', error);
            return;
          }
          const isGroupConversation =
            conversationForSend.type === 'group' ||
            conversationForSend.conversationType === 'group';
          const failedMessageDestinationId = isGroupConversation
            ? (conversationForSend.groupId ?? conversationForSend.id)
            : (conversationForSend.serviceId ?? conversationForSend.id);
          const failedMessageId = `sent:${failedMessageDestinationId}:${timestamp}`;
          const failedMessage: WebMessage = {
            id: failedMessageId,
            attachments,
            body,
            conversationId,
            direction: 'outgoing',
            isViewOnce: isViewOnceActive,
            quote: getWebQuoteForSend(quotedMessage),
            receivedAt: timestamp,
            sourceServiceId: credentials.aci,
            status: 'error',
            timestamp,
          };
          setShell(current => {
            if (!current.messages.some(item => item.id === failedMessageId)) {
              return current;
            }
            const nextShell = {
              ...current,
              messages: current.messages.map(item =>
                item.id === failedMessageId ? failedMessage : item
              ),
            };
            setWebRuntimeChatShell(nextShell);
            void persistChatShellStateToStorage(
              nextShell,
              linkedSession.credentials?.aci
            );
            return nextShell;
          });
          registerMessageInCache(failedMessage);
          window.reduxActions?.conversations?.messageChanged?.(
            failedMessage.id,
            failedMessage.conversationId,
            toDesktopMessage(failedMessage)
          );
          inputApi.current?.setContents(body, undefined, true);
          setDraftText(body);
          setDirty(Boolean(body) || attachments.length > 0);
          console.error('Failed to send web message', error);
        } finally {
          setIsSending(false);
        }
      })();

      return true;
    },
    [
      conversationId,
      conversation,
      discardEditMessage,
      draftEditMessage,
      isSending,
      linkedSession,
      messageRuntimeSessionId,
      pendingAttachments,
      setShell,
      shellRef,
      showToast,
      quotedMessage,
      revokePendingAttachmentUrls,
      uploadAttachmentsForSend,
      isViewOnceActive,
      setQuoteByMessageId,
    ]
  );

  const handleForceSend = useCallback(() => {
    setLarge(false);
    if (pendingAttachments.length > 0 && !draftText.trim()) {
      send('', Date.now());
      return;
    }
    inputApi.current?.submit();
  }, [draftText, pendingAttachments.length, send]);

  const handleToggleLarge = useCallback(() => {
    setLarge(current => !current);
  }, []);

  const hideToast = useCallback(() => undefined, []);
  const handleRecordingError = useCallback(() => undefined, []);
  const saveDraftRecordingIfNeeded = useCallback(() => undefined, []);

  const startRecording = useCallback(() => {
    if (
      isRecordingVoiceNote ||
      isSending ||
      isUploadingAttachment ||
      pendingAttachments.length > 0
    ) {
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      console.error(
        'Web voice note recording requires browser microphone access'
      );
      return;
    }

    void (async () => {
      try {
        const recorder = new AudioRecorder();
        voiceRecorderRef.current = recorder;
        voiceCancelRef.current = false;
        voiceStartedAtRef.current = Date.now();
        voicePeakIndexRef.current = 0;
        setVoicePeaks([]);

        const started = await recorder.start(value => {
          const peak: PeakType = {
            index: voicePeakIndexRef.current,
            value: Math.max(0.04, Math.min(1, value)),
          };
          voicePeakIndexRef.current += 1;
          setVoicePeaks(current => [...current.slice(-80), peak]);
        });
        if (!started) {
          resetVoiceRecordingState();
          return;
        }

        setIsRecordingVoiceNote(true);
      } catch (error) {
        resetVoiceRecordingState();
        console.error('Failed to start web voice note recording', error);
      }
    })();
  }, [
    isRecordingVoiceNote,
    isSending,
    isUploadingAttachment,
    messageRuntimeSessionId,
    pendingAttachments.length,
    resetVoiceRecordingState,
    send,
  ]);

  const cancelVoiceRecording = useCallback(() => {
    voiceCancelRef.current = true;
    const recorder = voiceRecorderRef.current;
    void recorder?.stop();
    resetVoiceRecordingState();
  }, [resetVoiceRecordingState]);

  const sendVoiceRecording = useCallback(() => {
    voiceCancelRef.current = false;
    const recorder = voiceRecorderRef.current;
    if (!recorder) {
      return;
    }
    const wasCancelled = voiceCancelRef.current;
    const startedAt = voiceStartedAtRef.current;
    const stoppedAt = Date.now();
    resetVoiceRecordingState();
    if (wasCancelled) {
      return;
    }

    setIsUploadingAttachment(true);
    void (async () => {
      try {
        const data = await recorder.stop();
        if (!data || data.byteLength === 0) {
          return;
        }

        const blob = new Blob([data], { type: AUDIO_MPEG });
        const file = new File([blob], 'voice-message.mp3', {
          type: AUDIO_MPEG,
        });
        const url = URL.createObjectURL(blob);
        const duration = Math.max(1, Math.ceil((stoppedAt - startedAt) / 1000));
        const uploadedAttachment = await uploadMessageAttachment({
          file,
          runtimeSessionId: messageRuntimeSessionId,
        });
        const voiceAttachment: WebAttachment = {
          ...uploadedAttachment,
          id:
            uploadedAttachment.id ??
            `voice-note-${stoppedAt}-${Math.floor(Math.random() * 100000)}`,
          clientUuid: uploadedAttachment.clientUuid ?? generateUuid(),
          contentType: AUDIO_MPEG,
          duration,
          flags: Proto.AttachmentPointer.Flags.VOICE_MESSAGE,
          kind: 'file',
          path: url,
          size: data.byteLength,
          status: 'ready',
          url,
        };
        send('', Date.now(), [voiceAttachment]);
      } catch (error) {
        console.error('Failed to send web voice note', error);
      } finally {
        setIsUploadingAttachment(false);
      }
    })();
  }, [messageRuntimeSessionId, resetVoiceRecordingState, send]);

  const shouldShowMicrophone =
    !draftEditMessage &&
    !large &&
    !dirty &&
    !draftText.trim() &&
    pendingAttachments.length === 0 &&
    !isUploadingAttachment;

  const editMessageFragment = draftEditMessage ? (
    <>
      {large ? <div className="CompositionArea__placeholder" /> : null}
      <div className="CompositionArea__button-cell CompositionArea__button-edit">
        <button
          aria-label={i18n('icu:CompositionArea__edit-action--discard')}
          className="CompositionArea__edit-button CompositionArea__edit-button--discard"
          onClick={() => {
            discardEditMessage(conversationId);
            inputApi.current?.reset();
            setDraftText('');
            setDirty(false);
          }}
          type="button"
        />
        <button
          aria-label={i18n('icu:CompositionArea__edit-action--send')}
          className="CompositionArea__edit-button CompositionArea__edit-button--accept"
          disabled={!dirty || isSending}
          onClick={handleForceSend}
          type="button"
        />
      </div>
    </>
  ) : null;

  const handleEmoji = useCallback((emojiSelection: FunEmojiSelection) => {
    inputApi.current?.insertEmoji(emojiSelection);
  }, []);

  const handleSticker = useCallback((stickerSelection: FunStickerSelection) => {
    console.warn(
      'Web sticker selection is available, but sticker protocol send is not wired to the bridge yet',
      stickerSelection
    );
  }, []);

  const handleAttachmentChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.currentTarget.files ?? []);
      event.currentTarget.value = '';
      if (files.length === 0) {
        return;
      }

      setIsUploadingAttachment(true);
      void (async () => {
        try {
          const drafts = await Promise.all(files.map(fileToDraftAttachment));
          drafts.forEach((attachment, index) => {
            const file = files[index];
            if (attachment.id && file) {
              pendingAttachmentFilesRef.current.set(attachment.id, file);
            }
          });
          setPendingAttachments(current => [...current, ...drafts]);
          setDirty(true);
        } catch (error) {
          console.error('Failed to stage web attachment', error);
        } finally {
          setIsUploadingAttachment(false);
        }
      })();
    },
    []
  );

  const removePendingAttachment = useCallback(
    (attachmentId: string | undefined) => {
      setPendingAttachments(current =>
        current.filter(attachment => {
          if (attachment.id === attachmentId) {
            revokePendingAttachmentUrls([attachment]);
            return false;
          }
          return true;
        })
      );
    },
    [revokePendingAttachmentUrls]
  );

  if (isRecordingVoiceNote) {
    return (
      <CompositionRecording
        i18n={i18n}
        onCancel={cancelVoiceRecording}
        onSend={sendVoiceRecording}
        errorRecording={handleRecordingError}
        peaks={voicePeaks}
        saveDraftRecordingIfNeeded={saveDraftRecordingIfNeeded}
        showToast={showToast}
        hideToast={hideToast}
      />
    );
  }

  if (selectedMessageIds != null) {
    return (
      <SelectModeActions
        i18n={i18n}
        selectedMessageIds={selectedMessageIds}
        areSelectedMessagesForwardable={areSelectedMessagesForwardable === true}
        onExitSelectMode={() => {
          toggleSelectMode(false);
        }}
        onDeleteMessages={() => {
          window.reduxActions.globalModals.toggleDeleteMessagesModal({
            conversationId,
            messageIds: selectedMessageIds,
            onDelete() {
              toggleSelectMode(false);
            },
          });
        }}
        onForwardMessages={() => {
          if (selectedMessageIds.length > 0) {
            toggleForwardMessagesModal(
              {
                type: ForwardMessagesModalType.Forward,
                messageIds: selectedMessageIds,
              },
              () => {
                toggleSelectMode(false);
              }
            );
          }
        }}
        showToast={showToast}
      />
    );
  }

  if (
    conversation.isBlocked ||
    (!conversation.acceptedMessageRequest &&
      conversation.removalStage !== 'justNotification')
  ) {
    return (
      <MessageRequestActions
        addedByName={addedByName}
        conversationId={conversationId}
        conversationName={conversationName}
        conversationType={conversation.type}
        getSharedGroupNames={getSharedGroupNames}
        i18n={i18n}
        isBlocked={conversation.isBlocked ?? false}
        isHidden={conversation.removalStage != null}
        isReported={conversation.isReported ?? false}
        acceptConversation={acceptConversation}
        blockAndReportSpam={blockAndReportSpam}
        blockConversation={blockConversation}
        reportSpam={reportSpam}
        deleteConversation={deleteConversation}
      />
    );
  }

  return (
    <div className="CompositionArea">
      {attachmentToEdit?.url ? (
        <MediaEditor
          draftBodyRanges={null}
          draftText={draftText}
          getPreferredBadge={getPreferredBadge}
          i18n={i18n}
          imageSrc={attachmentToEdit.url}
          imageToBlurHash={imageToBlurHash}
          isCreatingStory={false}
          isFormattingEnabled={isFormattingEnabled}
          isSending={false}
          convertDraftBodyRangesIntoHydrated={() => undefined}
          onClose={() => setAttachmentToEdit(null)}
          onDone={({
            caption,
            data,
            contentType,
            blurHash,
            isViewOnce: editorIsViewOnce,
          }) => {
            void (async () => {
              const blob = new Blob([data], { type: contentType });
              const url = URL.createObjectURL(blob);
              const imageDimensions = await getImageDimensions(url);
              const file = new File([blob], 'edited-image.png', {
                type: IMAGE_PNG,
              });
              setPendingAttachments(current =>
                current.map(attachment => {
                  if (attachment.id !== attachmentToEdit.id) {
                    return attachment;
                  }
                  revokePendingAttachmentUrls([attachment]);
                  if (attachment.id) {
                    pendingAttachmentFilesRef.current.set(attachment.id, file);
                  }
                  return {
                    ...attachment,
                    blurHash,
                    contentType: IMAGE_PNG,
                    fileName: attachment.fileName?.replace(/\.[^.]+$/, '.png'),
                    path: url,
                    size: data.byteLength,
                    status: 'pending',
                    url,
                    ...imageDimensions,
                  };
                })
              );
              setIsViewOnce(Boolean(editorIsViewOnce));
              setAttachmentToEdit(null);
              setDirty(true);
              if (caption) {
                setDraftText(caption);
                inputApi.current?.setContents(caption, undefined, true);
              }
            })();
          }}
          onSelectEmoji={handleEmoji}
          onTextTooLong={() => undefined}
          isViewOnce={isViewOnceActive}
          showViewOnceToggle={showViewOnceToggle}
          ourConversationId={ourConversationId}
          platform={platform}
          emojiSkinToneDefault={null}
          sortedGroupMembers={null}
        />
      ) : null}
      <input
        ref={mediaInput}
        type="file"
        accept="image/*,video/*"
        multiple
        hidden
        onChange={handleAttachmentChange}
      />
      <input
        ref={fileInput}
        type="file"
        multiple
        hidden
        onChange={handleAttachmentChange}
      />
      <div className="CompositionArea__toggle-large">
        <button
          type="button"
          className={classNames(
            'CompositionArea__toggle-large__button',
            large ? 'CompositionArea__toggle-large__button--large-active' : null
          )}
          onClick={handleToggleLarge}
          aria-label={i18n('icu:CompositionArea--expand')}
        />
      </div>
      <div className="CompositionArea__row CompositionArea__row--column">
        {quotedMessageProps ? (
          <div className="quote-wrapper">
            <Quote
              isCompose
              {...quotedMessageProps}
              i18n={i18n}
              onClick={
                quotedMessageId
                  ? () => scrollToMessage(conversationId, quotedMessageId)
                  : undefined
              }
              onClose={() => {
                setQuoteByMessageId(conversationId, undefined);
              }}
            />
          </div>
        ) : null}
        {pendingAttachments.length > 0 ? (
          <div className="CompositionArea__attachment-list">
            <AttachmentList
              attachments={pendingAttachments as never}
              canEditImages
              i18n={i18n}
              onAddAttachment={() => mediaInput.current?.click()}
              onClickAttachment={attachment => {
                const webAttachment = attachment as WebAttachment;
                if (
                  webAttachment.contentType?.startsWith('image/') &&
                  webAttachment.url
                ) {
                  setAttachmentToEdit(webAttachment);
                }
              }}
              onClose={() => {
                setPendingAttachments(current => {
                  revokePendingAttachmentUrls(current);
                  return [];
                });
                setDirty(false);
              }}
              onCloseAttachment={attachment => {
                removePendingAttachment((attachment as WebAttachment).id);
              }}
            />
          </div>
        ) : isUploadingAttachment ? (
          <div className="WebCompositionAttachments">
            <div className="WebCompositionAttachments__item">
              <span className="WebCompositionAttachments__name">
                正在处理附件
              </span>
            </div>
          </div>
        ) : null}
      </div>
      <div
        className={classNames('CompositionArea__row', {
          'CompositionArea__row--padded': large,
        })}
      >
        {!large ? (
          <div className="CompositionArea__button-cell">
            <FunPicker
              placement="top start"
              open={funPickerOpen}
              onOpenChange={setFunPickerOpen}
              onSelectEmoji={handleEmoji}
              onSelectSticker={handleSticker}
              onSelectGif={() => undefined}
              onAddStickerPack={null}
              theme={theme}
            >
              <FunPickerButton i18n={i18n} />
            </FunPicker>
          </div>
        ) : null}
        <div
          className={classNames('CompositionArea__input', {
            'CompositionArea__input--padded': large,
          })}
        >
          <CompositionInput
            conversationId={conversationId}
            i18n={i18n}
            disabled={isSending}
            draftEditMessage={draftEditMessage}
            getPreferredBadge={getPreferredBadge}
            large={large}
            inputApi={inputApi}
            isFormattingEnabled={isFormattingEnabled}
            isActive
            sendCounter={sendCounter}
            emojiSkinToneDefault={null}
            draftText={draftText}
            draftBodyRanges={null}
            theme={theme}
            sortedGroupMembers={null}
            onDirtyChange={setDirty}
            onEditorStateChange={({ messageText }) => {
              setDraftText(messageText);
            }}
            onTextTooLong={() => undefined}
            onSelectEmoji={handleEmoji}
            onSubmit={(message, _bodyRanges, timestamp) =>
              send(message, timestamp)
            }
            ourConversationId={ourConversationId}
            platform={platform}
            showRecoveryKeyPasteWarning={false}
            quotedMessageId={null}
            shouldHidePopovers={false}
            linkPreviewLoading={false}
            linkPreviewResult={null}
            onCloseLinkPreview={() => undefined}
            showViewOnceButton={showViewOnceToggle}
            isViewOnceActive={isViewOnceActive}
            onToggleViewOnce={() => setIsViewOnce(current => !current)}
          ></CompositionInput>
        </div>
        {!large && !draftEditMessage ? (
          <div className="CompositionArea__button-cell">
            <AxoDropdownMenu.Root>
              <AxoDropdownMenu.Trigger>
                <AxoIconButton.Root
                  variant="borderless-secondary"
                  size="md"
                  label={i18n('icu:CompositionArea--attach-plus')}
                  tooltip={false}
                  symbol="plus"
                />
              </AxoDropdownMenu.Trigger>
              <AxoDropdownMenu.Content>
                <AxoDropdownMenu.Item
                  symbol="photo"
                  onSelect={() => mediaInput.current?.click()}
                >
                  {i18n('icu:CompositionArea__AttachMenu__PhotosAndVideos')}
                </AxoDropdownMenu.Item>
                <AxoDropdownMenu.Item
                  symbol="file"
                  onSelect={() => fileInput.current?.click()}
                >
                  {i18n('icu:CompositionArea__AttachMenu__File')}
                </AxoDropdownMenu.Item>
              </AxoDropdownMenu.Content>
            </AxoDropdownMenu.Root>
          </div>
        ) : null}
        {!large
          ? (editMessageFragment ??
            (shouldShowMicrophone ? (
              <div className="CompositionArea__button-cell">
                <AudioCapture
                  conversationId={conversationId}
                  draftAttachments={[]}
                  i18n={i18n}
                  showToast={showToast}
                  warmupRecording={() => undefined}
                  startRecording={startRecording}
                />
              </div>
            ) : (
              <div className="CompositionArea__button-cell">
                <AxoIconButton.Root
                  symbol="send-fill"
                  variant="primary"
                  size="md"
                  label={i18n('icu:sendMessageToContact')}
                  disabled={isSending}
                  onClick={handleForceSend}
                />
              </div>
            )))
          : null}
      </div>
      {large ? (
        <div className="CompositionArea__row CompositionArea__row--control-row">
          <div className="CompositionArea__button-cell">
            <FunPicker
              placement="top start"
              open={funPickerOpen}
              onOpenChange={setFunPickerOpen}
              onSelectEmoji={handleEmoji}
              onSelectSticker={handleSticker}
              onSelectGif={() => undefined}
              onAddStickerPack={null}
              theme={theme}
            >
              <FunPickerButton i18n={i18n} />
            </FunPicker>
          </div>
          {!draftEditMessage ? (
            <div className="CompositionArea__button-cell">
              <AxoDropdownMenu.Root>
                <AxoDropdownMenu.Trigger>
                  <AxoIconButton.Root
                    variant="borderless-secondary"
                    size="md"
                    label={i18n('icu:CompositionArea--attach-plus')}
                    tooltip={false}
                    symbol="plus"
                  />
                </AxoDropdownMenu.Trigger>
                <AxoDropdownMenu.Content>
                  <AxoDropdownMenu.Item
                    symbol="photo"
                    onSelect={() => mediaInput.current?.click()}
                  >
                    {i18n('icu:CompositionArea__AttachMenu__PhotosAndVideos')}
                  </AxoDropdownMenu.Item>
                  <AxoDropdownMenu.Item
                    symbol="file"
                    onSelect={() => fileInput.current?.click()}
                  >
                    {i18n('icu:CompositionArea__AttachMenu__File')}
                  </AxoDropdownMenu.Item>
                </AxoDropdownMenu.Content>
              </AxoDropdownMenu.Root>
            </div>
          ) : null}
          <div className="CompositionArea__placeholder" />
          {editMessageFragment ?? (
            <div className="CompositionArea__button-cell">
              <AxoIconButton.Root
                symbol="send-fill"
                variant="primary"
                size="md"
                label={i18n('icu:sendMessageToContact')}
                disabled={!dirty || isSending}
                onClick={handleForceSend}
              />
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

function WebCompositionAreaFromContext({
  conversationId,
}: Readonly<{
  conversationId: string;
}>): JSX.Element {
  const { linkedSession, messageRuntimeSessionId, shellRef, setShell } =
    useWebConversationRuntimeContext();
  useWebConversationRenderDebug('WebCompositionAreaFromContext', {
    conversationId,
    messageRuntimeSessionId,
    shellMessages: shellRef.current.messages.length,
  });

  return (
    <WebCompositionArea
      conversationId={conversationId}
      linkedSession={linkedSession}
      messageRuntimeSessionId={messageRuntimeSessionId}
      shellRef={shellRef}
      setShell={setShell}
    />
  );
}

function renderWebCompositionArea(conversationId: string): JSX.Element {
  return <WebCompositionAreaFromContext conversationId={conversationId} />;
}

function renderWebConversationHeader(conversationId: string): JSX.Element {
  return <SmartConversationHeader id={conversationId} hideOutgoingCallButtons />;
}

function renderWebTimeline(conversationId: string): JSX.Element {
  return <SmartTimeline key={conversationId} id={conversationId} />;
}

function renderWebPanel(conversationId: string): JSX.Element {
  return <ConversationPanel conversationId={conversationId} />;
}

const WebConversation = memo(function WebConversation({
  selectedConversationId,
}: Readonly<{
  selectedConversationId: string;
}>): JSX.Element {
  const selectedMessageIds = useSelector(getSelectedMessageIds);
  const isSelectMode = selectedMessageIds != null;
  const { processAttachments } = useComposerActions();
  const { toggleSelectMode } = useConversationsActions();
  const hasOpenModal = useSelector(isShowingAnyModal);
  const activePanel = useSelector(getActivePanel);
  const isPanelAnimating = useSelector(getIsPanelAnimating);
  const shouldHideConversationView = activePanel != null && !isPanelAnimating;
  const onExitSelectMode = useCallback(() => {
    toggleSelectMode(false);
  }, [toggleSelectMode]);
  useWebConversationRenderDebug('WebConversation', {
    activePanel,
    isPanelAnimating,
    isSelectMode,
    selectedConversationId,
  });

  return (
    <ConversationView
      conversationId={selectedConversationId}
      hasOpenModal={hasOpenModal}
      hasOpenPanel={activePanel != null}
      isSelectMode={isSelectMode}
      onExitSelectMode={onExitSelectMode}
      processAttachments={processAttachments}
      renderCompositionArea={renderWebCompositionArea}
      renderConversationHeader={renderWebConversationHeader}
      renderTimeline={renderWebTimeline}
      renderPanel={renderWebPanel}
      shouldHideConversationView={shouldHideConversationView}
    />
  );
});

function renderWebConversationView({
  selectedConversationId,
}: Readonly<{
  selectedConversationId: string;
}>): JSX.Element {
  return <WebConversation selectedConversationId={selectedConversationId} />;
}

export const WebChatsTab = memo(function WebChatsTab({
  isRelinkRequired,
  linkedSession,
  messageRuntimeSessionId,
  onRelinkDevice,
  shell,
  setShell,
}: Readonly<{
  isRelinkRequired: boolean;
  linkedSession: LinkedSessionRecord;
  messageRuntimeSessionId?: string;
  onRelinkDevice: () => void;
  shell: ChatShellState;
  setShell: Dispatch<SetStateAction<ChatShellState>>;
}>): JSX.Element {
  const i18n = useSelector(getIntl);
  const navTabsCollapsed = useSelector(getNavTabsCollapsed);
  const otherTabsUnreadStats = useSelector(getOtherTabsUnreadStats);
  const selectedConversationId = useSelector(getSelectedConversationId);
  const targetedMessageId = useSelector(getTargetedMessage)?.id;
  const targetedMessageSource = useSelector(getTargetedMessageSource);
  const { toggleNavTabsCollapse } = useItemsActions();
  const { onConversationClosed, onConversationOpened, scrollToMessage } =
    useConversationsActions();
  const lastOpenedConversationId = useRef<string | undefined>(undefined);
  const shellRef = useRef(shell);
  shellRef.current = shell;

  useEffect(() => {
    if (selectedConversationId !== lastOpenedConversationId.current) {
      if (lastOpenedConversationId.current) {
        onConversationClosed(
          lastOpenedConversationId.current,
          'WebChatsTab opened another chat'
        );
      }
      lastOpenedConversationId.current = selectedConversationId;
      if (selectedConversationId) {
        onConversationOpened(
          selectedConversationId,
          targetedMessageId,
          targetedMessageSource
        );
      }
    } else if (
      selectedConversationId &&
      targetedMessageId &&
      targetedMessageSource === TargetedMessageSource.NavigateToMessage
    ) {
      scrollToMessage(selectedConversationId, targetedMessageId);
    }
  }, [
    onConversationClosed,
    onConversationOpened,
    scrollToMessage,
    selectedConversationId,
    targetedMessageId,
    targetedMessageSource,
  ]);
  const contextValue = useMemo(
    () => ({
      linkedSession,
      messageRuntimeSessionId,
      shellRef,
      setShell,
    }),
    [linkedSession, messageRuntimeSessionId, setShell]
  );
  const leftPaneContextValue = useMemo(
    () => ({
      forceRelinkDialog: isRelinkRequired,
      onRelinkDevice,
    }),
    [isRelinkRequired, onRelinkDevice]
  );
  useWebConversationRenderDebug('WebChatsTab', {
    selectedConversationId,
    shellMessages: shell.messages.length,
  });

  return (
    <WebConversationRuntimeContext.Provider value={contextValue}>
      <WebLeftPaneRuntimeContext.Provider value={leftPaneContextValue}>
        <ChatsTab
          otherTabsUnreadStats={otherTabsUnreadStats}
          i18n={i18n}
          isStaging={false}
          hasFailedStorySends={false}
          hasPendingUpdate={false}
          navTabsCollapsed={navTabsCollapsed}
          onToggleNavTabsCollapse={toggleNavTabsCollapse}
          renderConversationView={renderWebConversationView}
          renderLeftPane={renderLeftPane}
          renderMiniPlayer={renderMiniPlayer}
          selectedConversationId={selectedConversationId}
          showWhatsNewModal={noopShowWhatsNewModal}
        />
      </WebLeftPaneRuntimeContext.Provider>
    </WebConversationRuntimeContext.Provider>
  );
});
