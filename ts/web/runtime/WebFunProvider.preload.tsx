// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import type { ReactNode } from 'react';
import { memo, useCallback, useMemo } from 'react';
import { useSelector } from 'react-redux';

import { Emoji } from '../../axo/emoji.std.ts';
import { FunProvider } from '../../components/fun/FunProvider.dom.tsx';
import type { FunEmojiSelection } from '../../components/fun/panels/FunPanelEmojis.dom.tsx';
import type { FunStickerSelection } from '../../components/fun/panels/FunPanelStickers.dom.tsx';
import type { FunGifSelection } from '../../components/fun/panels/FunPanelGifs.dom.tsx';
import { useEmojisActions } from '../../state/ducks/emojis.preload.ts';
import { useGifsActions } from '../../state/ducks/gifs.preload.ts';
import { useItemsActions } from '../../state/ducks/items.preload.ts';
import { usePreferredReactionsActions } from '../../state/ducks/preferredReactions.preload.ts';
import { useStickersActions } from '../../state/ducks/stickers.preload.ts';
import { selectRecentEmojis } from '../../state/selectors/emojis.std.ts';
import { getRecentGifs } from '../../state/selectors/gifs.std.ts';
import {
  getEmojiSkinToneDefault,
  getShowStickerPickerHint,
} from '../../state/selectors/items.dom.ts';
import {
  getInstalledStickerPacks,
  getRecentStickers,
} from '../../state/selectors/stickers.std.ts';
import { getIntl } from '../../state/selectors/user.std.ts';
import { strictAssert } from '../../util/assert.std.ts';
import {
  fetchWebGiphyFile,
  fetchWebGiphySearch,
  fetchWebGiphyTrending,
} from './webGiphy.dom.ts';

export type WebFunProviderProps = Readonly<{
  children: ReactNode;
}>;

export const WebFunProvider = memo(function WebFunProvider(
  props: WebFunProviderProps
) {
  const i18n = useSelector(getIntl);
  const installedStickerPacks = useSelector(getInstalledStickerPacks);
  const recentEmojis = useSelector(selectRecentEmojis);
  const recentStickers = useSelector(getRecentStickers);
  const recentGifs = useSelector(getRecentGifs);
  const emojiSkinToneDefault = useSelector(getEmojiSkinToneDefault);
  const showStickerPickerHint = useSelector(getShowStickerPickerHint);

  const { removeItem, setEmojiSkinToneDefault } = useItemsActions();
  const { openCustomizePreferredReactionsModal } =
    usePreferredReactionsActions();
  const { onUseEmoji } = useEmojisActions();
  const { useSticker: onUseSticker } = useStickersActions();
  const { onAddRecentGif, onRemoveRecentGif } = useGifsActions();

  const recentEmojisKeys = useMemo(() => {
    return recentEmojis.map(emoji => {
      strictAssert(Emoji.isParent(emoji), `Invalid emoji parent: ${emoji}`);
      return emoji;
    });
  }, [recentEmojis]);

  const handleEmojiSkinToneDefaultChange = useCallback(
    (emojiSkinTone: Emoji.SkinTone) => {
      setEmojiSkinToneDefault(emojiSkinTone);
    },
    [setEmojiSkinToneDefault]
  );

  const handleOpenCustomizePreferredReactionsModal = useCallback(() => {
    openCustomizePreferredReactionsModal();
  }, [openCustomizePreferredReactionsModal]);

  const handleSelectEmoji = useCallback(
    (emojiSelection: FunEmojiSelection) => {
      onUseEmoji(emojiSelection);
    },
    [onUseEmoji]
  );

  const handleClearStickerPickerHint = useCallback(() => {
    removeItem('showStickerPickerHint');
  }, [removeItem]);

  const handleSelectSticker = useCallback(
    (stickerSelection: FunStickerSelection) => {
      onUseSticker(stickerSelection.stickerPackId, stickerSelection.stickerId);
    },
    [onUseSticker]
  );

  const handleSelectGif = useCallback(
    (gifSelection: FunGifSelection) => {
      onAddRecentGif(gifSelection.gif);
    },
    [onAddRecentGif]
  );

  return (
    <FunProvider
      i18n={i18n}
      recentEmojis={recentEmojisKeys}
      recentStickers={recentStickers}
      recentGifs={recentGifs}
      emojiSkinToneDefault={emojiSkinToneDefault}
      onEmojiSkinToneDefaultChange={handleEmojiSkinToneDefaultChange}
      onOpenCustomizePreferredReactionsModal={
        handleOpenCustomizePreferredReactionsModal
      }
      onSelectEmoji={handleSelectEmoji}
      installedStickerPacks={installedStickerPacks}
      showStickerPickerHint={showStickerPickerHint}
      onClearStickerPickerHint={handleClearStickerPickerHint}
      onSelectSticker={handleSelectSticker}
      fetchGiphySearch={fetchWebGiphySearch}
      fetchGiphyTrending={fetchWebGiphyTrending}
      fetchGiphyFile={fetchWebGiphyFile}
      onRemoveRecentGif={onRemoveRecentGif}
      onSelectGif={handleSelectGif}
    >
      {props.children}
    </FunProvider>
  );
});
