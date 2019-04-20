const { CompositeDisposable, Emitter } = require('atom');
const debounce = require('debounce');
const SearchModel = require('./search-model');
const { getActiveEditor } = require('./utils/editor-finders');

module.exports = class SelectionManager {
  constructor() {
    this.debouncedHandleSelection = this.debouncedHandleSelection.bind(this);

    this.searchModel = new SearchModel(this);

    this.emitter = new Emitter();
    this.editorToMarkerLayerMap = {};
    this.markerLayers = [];
    this.resultCount = 0;
    this.hideCandids = null;

    this.editorSubscriptions = new CompositeDisposable();
    this.editorSubscriptions.add(
      atom.workspace.observeTextEditors(editor => {
        this.setupMarkerLayers(editor);
      })
    );

    this.editorSubscriptions.add(
      atom.workspace.onWillDestroyPaneItem(item => {
        if (item.item.constructor.name !== 'TextEditor') {
          return;
        }
        const editor = item.item;
        this.removeMarkers(editor.id);
        delete this.editorToMarkerLayerMap[editor.id];
      })
    );

    this.enable();
    this.listenForTimeoutChange();
    this.activeItemSubscription = atom.workspace.onDidChangeActivePaneItem(() => {
      this.debouncedHandleSelection();
      return this.subscribeToActiveTextEditor();
    });
    this.subscribeToActiveTextEditor();

    this.onDidRemoveAllMarkers(()=> {
      if (this.enableAutofold) {
          this.toogleFoldNonSelected();
      }
    });
    this.onDidFinishAddingMarkers(()=> {
      if (this.enableAutofold) {
        this.toogleFoldNonSelected();
      }
    })
  }

  destroy() {
    this.handleSelectionDebounce.clear();
    this.activeItemSubscription.dispose();
    if (this.selectionSubscription) {
      this.selectionSubscription.dispose();
    }
    if (this.editorSubscriptions) {
      this.editorSubscriptions.dispose();
    }
  }

  onDidAddMarker(callback) {
    const Grim = require('grim'); // eslint-disable-line global-require
    Grim.deprecate('Please do not use. This method will be removed.');
    this.emitter.on('did-add-marker', callback);
  }

  onDidAddSelectedMarker(callback) {
    const Grim = require('grim'); // eslint-disable-line global-require
    Grim.deprecate('Please do not use. This method will be removed.');
    this.emitter.on('did-add-selected-marker', callback);
  }

  onDidAddMarkerForEditor(callback) {
    this.emitter.on('did-add-marker-for-editor', callback);
  }

  onDidAddSelectedMarkerForEditor(callback) {
    this.emitter.on('did-add-selected-marker-for-editor', callback);
  }

  onDidFinishAddingMarkers(callback) {
    this.emitter.on('did-finish-adding-markers', callback);
  }

  onDidRemoveAllMarkers(callback) {
    this.emitter.on('did-remove-marker-layer', callback);
  }

  disable() {
    this.disabled = true;
    return this.removeAllMarkers();
  }

  enable() {
    this.disabled = false;
    return this.debouncedHandleSelection();
  }

  debouncedHandleSelection() {
    if (!this.handleSelectionDebounce) {
      this.handleSelectionDebounce = debounce(() => {
        this.searchModel.handleSelection();
      }, atom.config.get('highlight-selected.timeout'));
    }
    return this.handleSelectionDebounce();
  }

  listenForTimeoutChange() {
    return atom.config.onDidChange('highlight-selected.timeout', () => {
      return this.debouncedHandleSelection();
    });
  }

  subscribeToActiveTextEditor() {
    if (this.selectionSubscription) {
      this.selectionSubscription.dispose();
    }

    const editor = getActiveEditor();
    if (!editor) {
      return;
    }

    this.selectionSubscription = new CompositeDisposable();

    this.selectionSubscription.add(editor.onDidAddSelection(this.debouncedHandleSelection));
    this.selectionSubscription.add(editor.onDidChangeSelectionRange(this.debouncedHandleSelection));
    this.searchModel.handleSelection();
  }

  removeAllMarkers() {
    return Object.keys(this.editorToMarkerLayerMap).forEach(editorId =>
      this.removeMarkers(editorId)
    );
  }

  removeMarkers(editorId) {
    if (!this.editorToMarkerLayerMap[editorId]) {
      return;
    }

    const { visibleMarkerLayer, selectedMarkerLayer } = this.editorToMarkerLayerMap[editorId];

    visibleMarkerLayer.clear();
    selectedMarkerLayer.clear();

    this.resultCount = 0;
    this.emitter.emit('did-remove-marker-layer');
  }

  selectAll() {
    const editor = getActiveEditor();
    const markerLayers = this.editorToMarkerLayerMap[editor.id];
    if (!markerLayers) {
      return;
    }
    const ranges = [];
    [markerLayers.visibleMarkerLayer, markerLayers.selectedMarkerLayer].forEach(markerLayer => {
      markerLayer.getMarkers().forEach(marker => {
        ranges.push(marker.getBufferRange());
      });
    });

    if (ranges.length > 0) {
      editor.setSelectedBufferRanges(ranges, { flash: true });
    }
  }

  unfoldNonSelected() {
    const editor = getActiveEditor();
    editor.unfoldAll();
    this.hideCandids = null;
  }

  foldNonSelected() {
    this.hideCandids = [];
    const editor = getActiveEditor();
    const markerLayers = this.editorToMarkerLayerMap[editor.id];
    if (!markerLayers) {
      return;
    }
    const ranges = [];
    [markerLayers.visibleMarkerLayer, markerLayers.selectedMarkerLayer].forEach(markerLayer => {
      markerLayer.getMarkers().forEach(marker => {
        ranges.push(marker.getBufferRange());
      });
    });

    if (ranges.length > 0) {
      const rowLengths = editor.buffer.getText().split('\n').map((line)=>{return line.length});
      const LAST_LINE = rowLengths.length-1;
      const LAST_RANGE = ranges.length-1;
      // there are rows before the first selected
      if (ranges[0].start.row != 0) {
        const rowBeforeSelection = ranges[0].start.row-1;
        this.hideCandids.push({start: {row:0, column:0}, end:{row:rowBeforeSelection, column: rowLengths[rowBeforeSelection]}})
      }

      for (let i=1; i<LAST_RANGE+1; i++) {
        const range1 = ranges[i-1];
        const range2 = ranges[i];
        const startRow = range1.end.row+1;
        const startCol = 0;
        const endRow = range2.start.row-1;
        const endCol = rowLengths[endRow];
        if (startRow <= endRow) {
            this.hideCandids.push({start: {row:startRow, column:startCol}, end:{row:endRow, column: endCol}});
        }
      }

      if (ranges[LAST_RANGE].end.row != LAST_LINE) {
        const rowAfterSelection = ranges[LAST_RANGE].end.row+1;
        this.hideCandids.push({start: {row:rowAfterSelection, column: 0}, end:{row: LAST_LINE, column: rowLengths[LAST_LINE]}})
      }

      this.hideCandids.forEach((candid) => {
        editor.foldBufferRange(candid);
      });
    }

  }

  toogleFoldNonSelected() {
    if (this.hideCandids) {
      this.unfoldNonSelected();
      return;
    }
    this.foldNonSelected();
  }

  setupMarkerLayers(editor) {
    let markerLayer;
    let markerLayerForHiddenMarkers;
    if (this.editorToMarkerLayerMap[editor.id]) {
      markerLayer = this.editorToMarkerLayerMap[editor.id].visibleMarkerLayer;
      markerLayerForHiddenMarkers = this.editorToMarkerLayerMap[editor.id].selectedMarkerLayer;
    }
    markerLayer = editor.addMarkerLayer();
    markerLayerForHiddenMarkers = editor.addMarkerLayer();
    this.editorToMarkerLayerMap[editor.id] = {
      visibleMarkerLayer: markerLayer,
      selectedMarkerLayer: markerLayerForHiddenMarkers
    };
  }
};
