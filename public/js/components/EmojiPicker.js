// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * EmojiPicker - GitHub-style emoji autocomplete popup for textareas
 * Shows emoji suggestions when user types ":" and filters as they type.
 * Supports keyboard navigation and click selection.
 */
class EmojiPicker {
  /**
   * Curated list of common emoji with their shortcodes
   * Each entry: [shortcode, unicode emoji]
   */
  static EMOJI_LIST = [
    // Faces - positive
    ['smile', '\u{1F604}'],
    ['grin', '\u{1F600}'],
    ['grinning', '\u{1F600}'],
    ['laughing', '\u{1F606}'],
    ['joy', '\u{1F602}'],
    ['rofl', '\u{1F923}'],
    ['smiley', '\u{1F603}'],
    ['wink', '\u{1F609}'],
    ['blush', '\u{1F60A}'],
    ['innocent', '\u{1F607}'],
    ['heart_eyes', '\u{1F60D}'],
    ['star_struck', '\u{1F929}'],
    ['kissing_heart', '\u{1F618}'],
    ['yum', '\u{1F60B}'],
    ['sunglasses', '\u{1F60E}'],
    ['smirk', '\u{1F60F}'],
    ['relaxed', '\u{263A}\u{FE0F}'],
    ['relieved', '\u{1F60C}'],
    ['partying_face', '\u{1F973}'],

    // Faces - thinking/neutral
    ['thinking', '\u{1F914}'],
    ['raised_eyebrow', '\u{1F928}'],
    ['neutral_face', '\u{1F610}'],
    ['expressionless', '\u{1F611}'],
    ['no_mouth', '\u{1F636}'],
    ['face_in_clouds', '\u{1F636}\u{200D}\u{1F32B}\u{FE0F}'],
    ['unamused', '\u{1F612}'],
    ['rolling_eyes', '\u{1F644}'],
    ['grimacing', '\u{1F62C}'],
    ['zipper_mouth', '\u{1F910}'],
    ['shushing_face', '\u{1F92B}'],

    // Faces - negative
    ['confused', '\u{1F615}'],
    ['worried', '\u{1F61F}'],
    ['frowning', '\u{1F641}'],
    ['disappointed', '\u{1F61E}'],
    ['persevere', '\u{1F623}'],
    ['confounded', '\u{1F616}'],
    ['tired_face', '\u{1F62B}'],
    ['weary', '\u{1F629}'],
    ['cry', '\u{1F622}'],
    ['sob', '\u{1F62D}'],
    ['angry', '\u{1F620}'],
    ['rage', '\u{1F621}'],
    ['exploding_head', '\u{1F92F}'],
    ['flushed', '\u{1F633}'],
    ['fearful', '\u{1F628}'],
    ['cold_sweat', '\u{1F630}'],
    ['scream', '\u{1F631}'],
    ['skull', '\u{1F480}'],

    // Faces - misc
    ['eyes', '\u{1F440}'],
    ['eye', '\u{1F441}\u{FE0F}'],
    ['see_no_evil', '\u{1F648}'],
    ['hear_no_evil', '\u{1F649}'],
    ['speak_no_evil', '\u{1F64A}'],
    ['nerd_face', '\u{1F913}'],
    ['monocle_face', '\u{1F9D0}'],
    ['clown_face', '\u{1F921}'],
    ['cowboy_hat_face', '\u{1F920}'],
    ['robot', '\u{1F916}'],
    ['alien', '\u{1F47D}'],
    ['ghost', '\u{1F47B}'],

    // Gestures
    ['thumbsup', '\u{1F44D}'],
    ['+1', '\u{1F44D}'],
    ['thumbsdown', '\u{1F44E}'],
    ['-1', '\u{1F44E}'],
    ['clap', '\u{1F44F}'],
    ['raised_hands', '\u{1F64C}'],
    ['open_hands', '\u{1F450}'],
    ['pray', '\u{1F64F}'],
    ['handshake', '\u{1F91D}'],
    ['point_up', '\u{261D}\u{FE0F}'],
    ['point_down', '\u{1F447}'],
    ['point_left', '\u{1F448}'],
    ['point_right', '\u{1F449}'],
    ['ok_hand', '\u{1F44C}'],
    ['v', '\u{270C}\u{FE0F}'],
    ['metal', '\u{1F918}'],
    ['call_me_hand', '\u{1F919}'],
    ['muscle', '\u{1F4AA}'],
    ['wave', '\u{1F44B}'],
    ['writing_hand', '\u{270D}\u{FE0F}'],
    ['fist', '\u{270A}'],
    ['punch', '\u{1F44A}'],

    // Hearts & love
    ['heart', '\u{2764}\u{FE0F}'],
    ['red_heart', '\u{2764}\u{FE0F}'],
    ['orange_heart', '\u{1F9E1}'],
    ['yellow_heart', '\u{1F49B}'],
    ['green_heart', '\u{1F49A}'],
    ['blue_heart', '\u{1F499}'],
    ['purple_heart', '\u{1F49C}'],
    ['black_heart', '\u{1F5A4}'],
    ['white_heart', '\u{1F90D}'],
    ['broken_heart', '\u{1F494}'],
    ['sparkling_heart', '\u{1F496}'],
    ['heartpulse', '\u{1F497}'],
    ['heartbeat', '\u{1F493}'],
    ['two_hearts', '\u{1F495}'],
    ['revolving_hearts', '\u{1F49E}'],
    ['cupid', '\u{1F498}'],
    ['gift_heart', '\u{1F49D}'],
    ['kiss', '\u{1F48B}'],

    // Celebration
    ['tada', '\u{1F389}'],
    ['confetti_ball', '\u{1F38A}'],
    ['balloon', '\u{1F388}'],
    ['gift', '\u{1F381}'],
    ['trophy', '\u{1F3C6}'],
    ['medal', '\u{1F3C5}'],
    ['first_place_medal', '\u{1F947}'],
    ['second_place_medal', '\u{1F948}'],
    ['third_place_medal', '\u{1F949}'],
    ['crown', '\u{1F451}'],
    ['gem', '\u{1F48E}'],
    ['ribbon', '\u{1F380}'],

    // Objects - tech
    ['computer', '\u{1F4BB}'],
    ['keyboard', '\u{2328}\u{FE0F}'],
    ['desktop_computer', '\u{1F5A5}\u{FE0F}'],
    ['printer', '\u{1F5A8}\u{FE0F}'],
    ['mouse', '\u{1F5B1}\u{FE0F}'],
    ['cd', '\u{1F4BF}'],
    ['dvd', '\u{1F4C0}'],
    ['floppy_disk', '\u{1F4BE}'],
    ['minidisc', '\u{1F4BD}'],
    ['iphone', '\u{1F4F1}'],
    ['telephone', '\u{260E}\u{FE0F}'],
    ['pager', '\u{1F4DF}'],
    ['battery', '\u{1F50B}'],
    ['electric_plug', '\u{1F50C}'],
    ['bulb', '\u{1F4A1}'],
    ['flashlight', '\u{1F526}'],
    ['satellite', '\u{1F4E1}'],

    // Objects - tools
    ['wrench', '\u{1F527}'],
    ['hammer', '\u{1F528}'],
    ['nut_and_bolt', '\u{1F529}'],
    ['gear', '\u{2699}\u{FE0F}'],
    ['chains', '\u{26D3}\u{FE0F}'],
    ['toolbox', '\u{1F9F0}'],
    ['screwdriver', '\u{1FA9B}'],
    ['magnet', '\u{1F9F2}'],
    ['alembic', '\u{2697}\u{FE0F}'],
    ['microscope', '\u{1F52C}'],
    ['telescope', '\u{1F52D}'],
    ['link', '\u{1F517}'],

    // Status/symbols
    ['check', '\u{2714}\u{FE0F}'],
    ['heavy_check_mark', '\u{2714}\u{FE0F}'],
    ['white_check_mark', '\u{2705}'],
    ['ballot_box_with_check', '\u{2611}\u{FE0F}'],
    ['x', '\u{274C}'],
    ['negative_squared_cross_mark', '\u{274E}'],
    ['warning', '\u{26A0}\u{FE0F}'],
    ['no_entry', '\u{26D4}'],
    ['no_entry_sign', '\u{1F6AB}'],
    ['stop_sign', '\u{1F6D1}'],
    ['question', '\u{2753}'],
    ['grey_question', '\u{2754}'],
    ['exclamation', '\u{2757}'],
    ['grey_exclamation', '\u{2755}'],
    ['bangbang', '\u{203C}\u{FE0F}'],
    ['interrobang', '\u{2049}\u{FE0F}'],
    ['information_source', '\u{2139}\u{FE0F}'],
    ['recycle', '\u{267B}\u{FE0F}'],

    // Code/dev related
    ['bug', '\u{1F41B}'],
    ['lady_beetle', '\u{1F41E}'],
    ['ant', '\u{1F41C}'],
    ['bee', '\u{1F41D}'],
    ['spider', '\u{1F577}\u{FE0F}'],
    ['spider_web', '\u{1F578}\u{FE0F}'],
    ['rocket', '\u{1F680}'],
    ['fire', '\u{1F525}'],
    ['sparkles', '\u{2728}'],
    ['star', '\u{2B50}'],
    ['star2', '\u{1F31F}'],
    ['stars', '\u{1F320}'],
    ['zap', '\u{26A1}'],
    ['boom', '\u{1F4A5}'],
    ['collision', '\u{1F4A5}'],
    ['dizzy', '\u{1F4AB}'],
    ['memo', '\u{1F4DD}'],
    ['pencil', '\u{270F}\u{FE0F}'],
    ['pencil2', '\u{270F}\u{FE0F}'],
    ['pen', '\u{1F58A}\u{FE0F}'],
    ['clipboard', '\u{1F4CB}'],
    ['pushpin', '\u{1F4CC}'],
    ['paperclip', '\u{1F4CE}'],
    ['bookmark', '\u{1F516}'],
    ['label', '\u{1F3F7}\u{FE0F}'],
    ['mag', '\u{1F50D}'],
    ['mag_right', '\u{1F50E}'],
    ['lock', '\u{1F512}'],
    ['unlock', '\u{1F513}'],
    ['key', '\u{1F511}'],
    ['old_key', '\u{1F5DD}\u{FE0F}'],
    ['shield', '\u{1F6E1}\u{FE0F}'],
    ['package', '\u{1F4E6}'],
    ['inbox_tray', '\u{1F4E5}'],
    ['outbox_tray', '\u{1F4E4}'],
    ['file_folder', '\u{1F4C1}'],
    ['open_file_folder', '\u{1F4C2}'],
    ['card_index_dividers', '\u{1F5C2}\u{FE0F}'],
    ['page_facing_up', '\u{1F4C4}'],
    ['page_with_curl', '\u{1F4C3}'],
    ['bookmark_tabs', '\u{1F4D1}'],
    ['wastebasket', '\u{1F5D1}\u{FE0F}'],
    ['scroll', '\u{1F4DC}'],
    ['books', '\u{1F4DA}'],
    ['book', '\u{1F4D6}'],
    ['closed_book', '\u{1F4D5}'],
    ['green_book', '\u{1F4D7}'],
    ['blue_book', '\u{1F4D8}'],
    ['orange_book', '\u{1F4D9}'],
    ['notebook', '\u{1F4D3}'],
    ['notebook_with_decorative_cover', '\u{1F4D4}'],
    ['ledger', '\u{1F4D2}'],

    // Arrows & directions
    ['arrow_up', '\u{2B06}\u{FE0F}'],
    ['arrow_down', '\u{2B07}\u{FE0F}'],
    ['arrow_left', '\u{2B05}\u{FE0F}'],
    ['arrow_right', '\u{27A1}\u{FE0F}'],
    ['arrow_upper_left', '\u{2196}\u{FE0F}'],
    ['arrow_upper_right', '\u{2197}\u{FE0F}'],
    ['arrow_lower_left', '\u{2199}\u{FE0F}'],
    ['arrow_lower_right', '\u{2198}\u{FE0F}'],
    ['arrows_counterclockwise', '\u{1F504}'],
    ['arrows_clockwise', '\u{1F503}'],
    ['left_right_arrow', '\u{2194}\u{FE0F}'],
    ['arrow_up_down', '\u{2195}\u{FE0F}'],
    ['fast_forward', '\u{23E9}'],
    ['rewind', '\u{23EA}'],
    ['twisted_rightwards_arrows', '\u{1F500}'],
    ['repeat', '\u{1F501}'],
    ['repeat_one', '\u{1F502}'],

    // Time
    ['hourglass', '\u{231B}'],
    ['hourglass_flowing_sand', '\u{23F3}'],
    ['watch', '\u{231A}'],
    ['alarm_clock', '\u{23F0}'],
    ['stopwatch', '\u{23F1}\u{FE0F}'],
    ['timer_clock', '\u{23F2}\u{FE0F}'],
    ['clock', '\u{1F570}\u{FE0F}'],
    ['calendar', '\u{1F4C5}'],
    ['date', '\u{1F4C5}'],
    ['calendar_spiral', '\u{1F5D3}\u{FE0F}'],

    // Weather & nature
    ['sun_with_face', '\u{1F31E}'],
    ['sunny', '\u{2600}\u{FE0F}'],
    ['cloud', '\u{2601}\u{FE0F}'],
    ['rain', '\u{1F327}\u{FE0F}'],
    ['thunder_cloud_and_rain', '\u{26C8}\u{FE0F}'],
    ['rainbow', '\u{1F308}'],
    ['snowflake', '\u{2744}\u{FE0F}'],
    ['snowman', '\u{2603}\u{FE0F}'],
    ['wind_blowing_face', '\u{1F32C}\u{FE0F}'],
    ['fog', '\u{1F32B}\u{FE0F}'],
    ['ocean', '\u{1F30A}'],
    ['droplet', '\u{1F4A7}'],
    ['seedling', '\u{1F331}'],
    ['evergreen_tree', '\u{1F332}'],
    ['deciduous_tree', '\u{1F333}'],
    ['palm_tree', '\u{1F334}'],
    ['cactus', '\u{1F335}'],
    ['herb', '\u{1F33F}'],
    ['four_leaf_clover', '\u{1F340}'],
    ['maple_leaf', '\u{1F341}'],
    ['fallen_leaf', '\u{1F342}'],
    ['leaves', '\u{1F343}'],
    ['mushroom', '\u{1F344}'],
    ['rose', '\u{1F339}'],
    ['sunflower', '\u{1F33B}'],
    ['blossom', '\u{1F33C}'],
    ['tulip', '\u{1F337}'],
    ['cherry_blossom', '\u{1F338}'],
    ['bouquet', '\u{1F490}'],

    // Food
    ['coffee', '\u{2615}'],
    ['tea', '\u{1F375}'],
    ['beer', '\u{1F37A}'],
    ['beers', '\u{1F37B}'],
    ['wine_glass', '\u{1F377}'],
    ['champagne', '\u{1F37E}'],
    ['cocktail', '\u{1F378}'],
    ['pizza', '\u{1F355}'],
    ['hamburger', '\u{1F354}'],
    ['fries', '\u{1F35F}'],
    ['hotdog', '\u{1F32D}'],
    ['taco', '\u{1F32E}'],
    ['burrito', '\u{1F32F}'],
    ['popcorn', '\u{1F37F}'],
    ['cake', '\u{1F370}'],
    ['birthday', '\u{1F382}'],
    ['cookie', '\u{1F36A}'],
    ['doughnut', '\u{1F369}'],
    ['ice_cream', '\u{1F368}'],
    ['apple', '\u{1F34E}'],
    ['green_apple', '\u{1F34F}'],
    ['lemon', '\u{1F34B}'],
    ['banana', '\u{1F34C}'],
    ['watermelon', '\u{1F349}'],
    ['grapes', '\u{1F347}'],
    ['strawberry', '\u{1F353}'],
    ['peach', '\u{1F351}'],
    ['cherries', '\u{1F352}'],
    ['avocado', '\u{1F951}'],
    ['eggplant', '\u{1F346}'],
    ['tomato', '\u{1F345}'],
    ['corn', '\u{1F33D}'],
    ['carrot', '\u{1F955}'],
    ['hot_pepper', '\u{1F336}\u{FE0F}'],

    // Animals
    ['dog', '\u{1F436}'],
    ['cat', '\u{1F431}'],
    ['mouse_face', '\u{1F42D}'],
    ['hamster', '\u{1F439}'],
    ['rabbit', '\u{1F430}'],
    ['fox_face', '\u{1F98A}'],
    ['bear', '\u{1F43B}'],
    ['panda_face', '\u{1F43C}'],
    ['koala', '\u{1F428}'],
    ['tiger', '\u{1F42F}'],
    ['lion', '\u{1F981}'],
    ['cow', '\u{1F42E}'],
    ['pig', '\u{1F437}'],
    ['frog', '\u{1F438}'],
    ['monkey_face', '\u{1F435}'],
    ['chicken', '\u{1F414}'],
    ['penguin', '\u{1F427}'],
    ['bird', '\u{1F426}'],
    ['baby_chick', '\u{1F424}'],
    ['eagle', '\u{1F985}'],
    ['duck', '\u{1F986}'],
    ['owl', '\u{1F989}'],
    ['bat', '\u{1F987}'],
    ['wolf', '\u{1F43A}'],
    ['horse', '\u{1F434}'],
    ['unicorn', '\u{1F984}'],
    ['dragon', '\u{1F409}'],
    ['dragon_face', '\u{1F432}'],
    ['snake', '\u{1F40D}'],
    ['turtle', '\u{1F422}'],
    ['tropical_fish', '\u{1F420}'],
    ['fish', '\u{1F41F}'],
    ['dolphin', '\u{1F42C}'],
    ['whale', '\u{1F433}'],
    ['shark', '\u{1F988}'],
    ['octopus', '\u{1F419}'],
    ['crab', '\u{1F980}'],
    ['shrimp', '\u{1F990}'],
    ['lobster', '\u{1F99E}'],
    ['butterfly', '\u{1F98B}'],
    ['snail', '\u{1F40C}'],

    // Sports & activities
    ['soccer', '\u{26BD}'],
    ['basketball', '\u{1F3C0}'],
    ['football', '\u{1F3C8}'],
    ['baseball', '\u{26BE}'],
    ['tennis', '\u{1F3BE}'],
    ['volleyball', '\u{1F3D0}'],
    ['golf', '\u{26F3}'],
    ['dart', '\u{1F3AF}'],
    ['bowling', '\u{1F3B3}'],
    ['video_game', '\u{1F3AE}'],
    ['joystick', '\u{1F579}\u{FE0F}'],
    ['game_die', '\u{1F3B2}'],
    ['chess_pawn', '\u{265F}\u{FE0F}'],
    ['jigsaw', '\u{1F9E9}'],

    // Misc symbols
    ['100', '\u{1F4AF}'],
    ['speech_balloon', '\u{1F4AC}'],
    ['thought_balloon', '\u{1F4AD}'],
    ['left_speech_bubble', '\u{1F5E8}\u{FE0F}'],
    ['right_anger_bubble', '\u{1F5EF}\u{FE0F}'],
    ['zzz', '\u{1F4A4}'],
    ['sweat_drops', '\u{1F4A6}'],
    ['dash', '\u{1F4A8}'],
    ['poop', '\u{1F4A9}'],
    ['notes', '\u{1F3B6}'],
    ['musical_note', '\u{1F3B5}'],
    ['art', '\u{1F3A8}'],
    ['performing_arts', '\u{1F3AD}'],
    ['microphone', '\u{1F3A4}'],
    ['headphones', '\u{1F3A7}'],
    ['movie_camera', '\u{1F3A5}'],
    ['clapper', '\u{1F3AC}'],
    ['tv', '\u{1F4FA}'],
    ['camera', '\u{1F4F7}'],
    ['camera_flash', '\u{1F4F8}'],
    ['video_camera', '\u{1F4F9}'],
    ['mag', '\u{1F50D}'],
    ['candle', '\u{1F56F}\u{FE0F}'],
    ['newspaper', '\u{1F4F0}'],
    ['rolled_up_newspaper', '\u{1F5DE}\u{FE0F}'],
  ];

  /**
   * Create an EmojiPicker instance
   * @param {Object} options - Configuration options
   * @param {number} options.maxResults - Maximum results to show (default: 8)
   */
  constructor(options = {}) {
    this.maxResults = options.maxResults || 8;
    this.popup = null;
    this.activeTextarea = null;
    this.selectedIndex = 0;
    this.matches = [];
    this.triggerStart = -1; // Position where ":" was typed
    this.boundHandleKeydown = this.handleKeydown.bind(this);
    this.boundHandleClick = this.handleDocumentClick.bind(this);
  }

  /**
   * Attach emoji picker to a textarea element
   * @param {HTMLTextAreaElement} textarea - The textarea to attach to
   */
  attach(textarea) {
    if (!textarea || textarea._emojiPickerAttached) return;

    textarea._emojiPickerAttached = true;

    textarea.addEventListener('input', (e) => this.handleInput(e));
    textarea.addEventListener('keydown', (e) => this.handleTextareaKeydown(e));
    textarea.addEventListener('blur', (e) => {
      // Delay hiding to allow click on popup
      setTimeout(() => this.hidePopup(), 150);
    });
  }

  /**
   * Handle input events on textareas
   * @param {Event} e - Input event
   */
  handleInput(e) {
    const textarea = e.target;
    const value = textarea.value;
    const cursorPos = textarea.selectionStart;

    // Find the last ":" before cursor that's not part of a completed emoji
    let colonPos = -1;
    for (let i = cursorPos - 1; i >= 0; i--) {
      const char = value[i];
      if (char === ':') {
        // Check if this colon is preceded by another colon (completed emoji)
        // or is at start/after whitespace (new trigger)
        if (i === 0 || /\s/.test(value[i - 1])) {
          colonPos = i;
          break;
        }
        // Check if there's matching closing colon (completed)
        const textAfter = value.substring(i + 1, cursorPos);
        if (textAfter.includes(':')) {
          // This is likely a completed emoji, keep looking
          continue;
        }
        colonPos = i;
        break;
      }
      // Stop searching if we hit whitespace or newline
      if (/\s/.test(char)) {
        break;
      }
    }

    if (colonPos === -1) {
      this.hidePopup();
      return;
    }

    // Get the search text after the colon
    const searchText = value.substring(colonPos + 1, cursorPos);

    // Don't show popup for empty search if colon was just typed
    // But allow filtering with partial text
    if (searchText.length === 0 && this.triggerStart !== colonPos) {
      this.triggerStart = colonPos;
      this.showPopup(textarea, '');
    } else if (searchText.length > 0) {
      this.triggerStart = colonPos;
      this.showPopup(textarea, searchText);
    } else if (this.triggerStart === colonPos) {
      // Colon just typed, show all popular emoji
      this.showPopup(textarea, '');
    } else {
      this.hidePopup();
    }
  }

  /**
   * Handle keydown events on attached textareas
   * @param {KeyboardEvent} e - Keyboard event
   */
  handleTextareaKeydown(e) {
    if (!this.popup || this.popup.style.display === 'none') return;

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        this.selectNext();
        break;
      case 'ArrowUp':
        e.preventDefault();
        this.selectPrevious();
        break;
      case 'Enter':
      case 'Tab':
        if (this.matches.length > 0) {
          e.preventDefault();
          this.insertSelected();
        }
        break;
      case 'Escape':
        e.preventDefault();
        this.hidePopup();
        break;
    }
  }

  /**
   * Filter emoji list by search term
   * @param {string} search - Search term
   * @returns {Array} Filtered emoji list
   */
  filterEmoji(search) {
    if (!search) {
      // Return popular emoji when no search
      return EmojiPicker.EMOJI_LIST.slice(0, this.maxResults);
    }

    const lower = search.toLowerCase();
    const results = [];

    for (const [shortcode, emoji] of EmojiPicker.EMOJI_LIST) {
      if (shortcode.toLowerCase().startsWith(lower)) {
        results.push([shortcode, emoji]);
      }
      if (results.length >= this.maxResults) break;
    }

    // If not enough exact prefix matches, try contains
    if (results.length < this.maxResults) {
      for (const [shortcode, emoji] of EmojiPicker.EMOJI_LIST) {
        if (!shortcode.toLowerCase().startsWith(lower) &&
            shortcode.toLowerCase().includes(lower)) {
          results.push([shortcode, emoji]);
        }
        if (results.length >= this.maxResults) break;
      }
    }

    return results;
  }

  /**
   * Show the emoji picker popup
   * @param {HTMLTextAreaElement} textarea - The active textarea
   * @param {string} search - Current search term
   */
  showPopup(textarea, search) {
    this.activeTextarea = textarea;
    this.matches = this.filterEmoji(search);

    if (this.matches.length === 0) {
      this.hidePopup();
      return;
    }

    this.selectedIndex = 0;

    // Create popup if it doesn't exist
    if (!this.popup) {
      this.createPopup();
    }

    // Populate the popup
    this.renderMatches();

    // Position the popup near the cursor
    this.positionPopup(textarea);

    // Show popup
    this.popup.style.display = 'block';

    // Add document click listener
    document.addEventListener('click', this.boundHandleClick);
  }

  /**
   * Create the popup element
   */
  createPopup() {
    this.popup = document.createElement('div');
    this.popup.className = 'emoji-picker-popup';
    this.popup.style.display = 'none';
    document.body.appendChild(this.popup);
  }

  /**
   * Render the matches in the popup
   */
  renderMatches() {
    this.popup.innerHTML = '';

    this.matches.forEach(([shortcode, emoji], index) => {
      const item = document.createElement('div');
      item.className = 'emoji-picker-item';
      if (index === this.selectedIndex) {
        item.classList.add('selected');
      }

      item.innerHTML = `
        <span class="emoji-picker-emoji">${emoji}</span>
        <span class="emoji-picker-shortcode">:${shortcode}:</span>
      `;

      item.addEventListener('mouseenter', () => {
        this.selectedIndex = index;
        this.updateSelection();
      });

      item.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.insertEmoji(shortcode, emoji);
      });

      this.popup.appendChild(item);
    });
  }

  /**
   * Update the visual selection
   */
  updateSelection() {
    const items = this.popup.querySelectorAll('.emoji-picker-item');
    items.forEach((item, index) => {
      item.classList.toggle('selected', index === this.selectedIndex);
    });

    // Ensure selected item is visible
    const selectedItem = items[this.selectedIndex];
    if (selectedItem) {
      selectedItem.scrollIntoView({ block: 'nearest' });
    }
  }

  /**
   * Select the next item
   */
  selectNext() {
    if (this.selectedIndex < this.matches.length - 1) {
      this.selectedIndex++;
      this.updateSelection();
    }
  }

  /**
   * Select the previous item
   */
  selectPrevious() {
    if (this.selectedIndex > 0) {
      this.selectedIndex--;
      this.updateSelection();
    }
  }

  /**
   * Insert the currently selected emoji
   */
  insertSelected() {
    if (this.matches.length > 0 && this.selectedIndex >= 0) {
      const [shortcode, emoji] = this.matches[this.selectedIndex];
      this.insertEmoji(shortcode, emoji);
    }
  }

  /**
   * Insert an emoji into the textarea
   * @param {string} shortcode - The emoji shortcode
   * @param {string} emoji - The unicode emoji
   */
  insertEmoji(shortcode, emoji) {
    if (!this.activeTextarea) return;

    const textarea = this.activeTextarea;
    const value = textarea.value;
    const cursorPos = textarea.selectionStart;

    // Find the colon position to replace from
    const beforeCursor = value.substring(0, cursorPos);
    const colonPos = beforeCursor.lastIndexOf(':');

    if (colonPos === -1) {
      this.hidePopup();
      return;
    }

    // Replace :search with the emoji
    const before = value.substring(0, colonPos);
    const after = value.substring(cursorPos);
    const newValue = before + emoji + after;

    textarea.value = newValue;

    // Position cursor after the emoji
    const newCursorPos = colonPos + emoji.length;
    textarea.setSelectionRange(newCursorPos, newCursorPos);

    // Trigger input event for auto-resize and other listeners
    textarea.dispatchEvent(new Event('input', { bubbles: true }));

    // Hide popup
    this.hidePopup();

    // Focus textarea
    textarea.focus();
  }

  /**
   * Position the popup near the cursor in the textarea
   * @param {HTMLTextAreaElement} textarea - The textarea
   */
  positionPopup(textarea) {
    // Get textarea position
    const rect = textarea.getBoundingClientRect();

    // Create a temporary element to measure cursor position
    const mirror = document.createElement('div');
    const computed = window.getComputedStyle(textarea);

    // Copy textarea styles to mirror
    const stylesToCopy = [
      'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing',
      'textTransform', 'wordSpacing', 'textIndent', 'whiteSpace', 'wordWrap',
      'lineHeight', 'padding', 'paddingLeft', 'paddingRight', 'paddingTop',
      'paddingBottom', 'border', 'borderWidth', 'boxSizing'
    ];

    mirror.style.position = 'absolute';
    mirror.style.visibility = 'hidden';
    mirror.style.whiteSpace = 'pre-wrap';
    mirror.style.wordWrap = 'break-word';
    mirror.style.overflow = 'hidden';
    mirror.style.width = computed.width;

    stylesToCopy.forEach(style => {
      mirror.style[style] = computed[style];
    });

    document.body.appendChild(mirror);

    // Get text up to cursor
    const textBeforeCursor = textarea.value.substring(0, this.triggerStart);
    mirror.textContent = textBeforeCursor;

    // Add a span for the colon position
    const span = document.createElement('span');
    span.textContent = ':';
    mirror.appendChild(span);

    // Get position of the span
    const spanRect = span.getBoundingClientRect();
    const mirrorRect = mirror.getBoundingClientRect();

    // Calculate cursor position relative to textarea
    const cursorLeft = spanRect.left - mirrorRect.left;
    const cursorTop = spanRect.top - mirrorRect.top;

    // Clean up mirror
    document.body.removeChild(mirror);

    // Position popup
    const popupTop = rect.top + cursorTop + parseInt(computed.lineHeight) + window.scrollY;
    const popupLeft = rect.left + cursorLeft + window.scrollX;

    // Adjust if popup would go off screen
    const popupWidth = 280; // Approximate width
    const popupHeight = 300; // Approximate max height
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    let finalLeft = popupLeft;
    let finalTop = popupTop;

    // Check right edge
    if (finalLeft + popupWidth > viewportWidth - 10) {
      finalLeft = viewportWidth - popupWidth - 10;
    }

    // Check left edge
    if (finalLeft < 10) {
      finalLeft = 10;
    }

    // Check bottom edge - if popup would go below viewport, show above cursor
    if (finalTop + popupHeight > viewportHeight + window.scrollY - 10) {
      finalTop = rect.top + cursorTop - popupHeight + window.scrollY;
    }

    this.popup.style.top = `${finalTop}px`;
    this.popup.style.left = `${finalLeft}px`;
  }

  /**
   * Hide the popup
   */
  hidePopup() {
    if (this.popup) {
      this.popup.style.display = 'none';
    }
    this.triggerStart = -1;
    document.removeEventListener('click', this.boundHandleClick);
  }

  /**
   * Handle document click to close popup
   * @param {Event} e - Click event
   */
  handleDocumentClick(e) {
    if (this.popup && !this.popup.contains(e.target) && e.target !== this.activeTextarea) {
      this.hidePopup();
    }
  }

  /**
   * Handle keydown events (for document-level handling if needed)
   * @param {KeyboardEvent} e - Keyboard event
   */
  handleKeydown(e) {
    // This method is bound but used via textarea-specific handler
  }
}

// Create global emoji picker instance
if (typeof window !== 'undefined' && !window.emojiPicker) {
  window.emojiPicker = new EmojiPicker();
}

// Make EmojiPicker available globally
window.EmojiPicker = EmojiPicker;
