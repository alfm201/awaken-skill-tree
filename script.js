class SkillTreeSimulator {
  constructor() {
    // 로딩 인디케이터 초기화
    this.loadingIndicator = document.createElement('div');
    this.loadingIndicator.className = 'loading-indicator';
    this.loadingIndicator.innerHTML = `
      <div class="spinner"></div>
      <div class="loading-text">스킬 트리 로딩 중...</div>
    `;
    document.body.appendChild(this.loadingIndicator);

    // 실행 취소/되돌리기를 위한 상태 스택 먼저 초기화
    this.undoStack = [];
    this.redoStack = [];
    this.maxStackSize = 50;  // 최대 스택 크기

    // DOM 요소 초기화
    this.statsContainer = document.getElementById('statsContainer');
    this.toggleStatsButton = document.getElementById('toggleStats');
    this.statsWrapper = document.querySelector('.stats-wrapper');
    this.statsContent = document.querySelector('.stats-content');
    this.tabs = document.querySelectorAll('.tab');
    this.currentTab = 'all';
    
    // 포인트 초기화
    this.firstAwakenPoints = {
      total: 138,
      used: 0
    };
    this.secondAwakenPoints = {
      total: 115,
      used: 0
    };
    
    this.nodes = [];
    this.nodeMap = new Map();  // 노드 ID를 키로 하는 Map
    this.linesMap = new Map(); // 라인 ID를 키로 하는 Map
    this.adjList = new Map();  // 인접 리스트 추가
    this.links = [];
    this.jobId = "24"; // 기본 직업 ID (하이랜더)
    
    // 트리 경계값 캐시 초기화
    this._treeBounds = null;
    
    // 우클릭 드래그 상태 추가
    this.isRightDragging = false;
    
    // SVG 요소 초기화
    this.svg = d3.select("#skillTreeSvg")
      .on('contextmenu', (event) => {
        event.preventDefault();  // 기본 컨텍스트 메뉴 비활성화
      })
      .on('mousedown', (event) => {
        if (event.button === 2) {  // 우클릭
          this.isRightDragging = true;
          event.preventDefault();
        }
      })
      .on('mouseup', (event) => {
        if (event.button === 2) {  // 우클릭
          this.isRightDragging = false;
          event.preventDefault();
        }
      })
      .on('mouseleave', () => {
        this.isRightDragging = false;
      })
      .on('touchstart', () => {
        this.hideTooltip();  // 터치 시작 시 툴크 숨기기
      });
    this.container = this.svg.append("g");
    
    // defs 요소 초기화
    let defs = this.svg.select('defs');
    if (defs.empty()) {
      defs = this.svg.append('defs');
    }
    this.defs = defs;
    
    // 줌 기능 초기화
    this.zoom = d3.zoom()
      .scaleExtent([0.02, 10])
      .on('zoom', (event) => this.handleZoom(event))
      .filter(event => {
        if (event.type === 'dblclick') {
          event.preventDefault();
          return false;
        }
        return !event.ctrlKey && !event.button && (
          event.type === 'wheel' || 
          event.type === 'mousedown' ||
          event.type === 'mousemove' ||
          event.type === 'mouseup' ||
          event.type === 'touchstart' || 
          event.type === 'touchmove' ||
          event.type === 'touchend'
        );
      });
    
    this.svg
      .call(this.zoom)
      .on('dblclick.zoom', null);
    
    // 이벤트 리스너 설정
    this.setupEventListeners();
    
    // SVG 크기 설정
    this.updateSvgSize();
    window.addEventListener('resize', () => {
      const width = window.innerWidth;
      const height = window.innerHeight;
      this.svg
        .attr("width", width)
        .attr("height", height);
    });
    
    // 내부적인 URL 변경인지 추적하기 위한 플래그
    this.isInternalHashChange = false;
    
    // hashchange 이벤트 핸들러
    window.addEventListener('hashchange', () => this.handleHashChange());
    
    // URL에서 상태 불러오기
    this.loadFromURL();
    
    // 초기 시각화 및 중앙 정렬
    this.initializeSimulator().then(() => {
      // 스킬 데이터 로드 후 setupStatsDisplay 호출
      this.setupStatsDisplay();
    });
  }

  async loadSkillData() {
    try {
      const [skill1Response, skill2Response] = await Promise.all([
        fetch('assets/skill1.json'),
        fetch('assets/skill2.json')
      ]);
      
      const skill1Data = await skill1Response.json();
      const skill2Data = await skill2Response.json();

      // 직업 목록 추출 (시작 노드의 툴팁에서)
      const startNode = skill1Data.find(node => node.INSTANCEID === '101001');
      if (startNode) {
        const jobList = Object.entries(startNode)
          .filter(([key, value]) => !isNaN(key) && value && value.includes('【'))
          .map(([key, value]) => ({
            id: key,
            name: value.split('【')[1].split('】')[0].trim()
          }))
          .sort((a, b) => parseInt(a.id) - parseInt(b.id));  // ID 기준으로 정렬

        this.setupJobSelector(jobList);
      }
      
      this.nodes = [];
      this.nodeMap.clear();  // 노드 Map 초기화
      this.linesMap.clear(); // 라인 Map 초기화
      this.adjList.clear();  // 인접 리스트 초기화
      this._skill1MaxY = null;
      
      // 데이터 처리 함수
      const processNodes = (data) => {
        if (Array.isArray(data)) {
          // 먼저 모든 노드를 생성하고 Map에 추가
          data.forEach(node => {
            const nodeData = this.createNodeData(node);
            this.nodes.push(nodeData);
            this.nodeMap.set(nodeData.id, nodeData);
            this.adjList.set(nodeData.id, new Set());  // 인접 리스트 초기화
          });

          // required 정보를 기반으로 인접 리스트 구축
          this.nodes.forEach(node => {
            if (node.type === 'node' && node.required) {
              // 각 required 노드에 대해 양방향 연결 추가
              node.required.forEach(reqId => {
                if (this.nodeMap.has(reqId)) {
                  this.adjList.get(node.id).add(reqId);
                  this.adjList.get(reqId).add(node.id);
                }
              });
            }
          });

          // 라인과 노드 간의 관계 매핑 (시각적 표현을 위해 유지)
          this.nodes.forEach(node => {
            if (node.type === 'node' && node.connectedLines) {
              node.connectedLines.forEach(lineId => {
                if (!this.linesMap.has(lineId)) {
                  const lineNode = this.nodes.find(n => n.type === 'line' && n.id === lineId);
                  if (lineNode) {
                    this.linesMap.set(lineId, {
                      lineNode,
                      nodeIds: [node.id]
                    });
                  }
                } else {
                  const lineData = this.linesMap.get(lineId);
                  if (!lineData.nodeIds.includes(node.id)) {
                    lineData.nodeIds.push(node.id);
                  }
                }
              });
            }
          });
        }
      };

      // 데이터 처리
      processNodes(skill1Data);
      processNodes(skill2Data);
      
      // 타입별로 정렬 (배경 -> 라인 -> 노드 순서로 그리기 위해)
      this.nodes.sort((a, b) => {
        const typeOrder = { background: 0, line: 1, node: 2 };
        return typeOrder[a.type] - typeOrder[b.type];
      });
      
      if (this.nodes.length === 0) {
        throw new Error('No valid nodes loaded');
      }
      
      // 데이터 로드 시 경계값 캐시 초기화
      this._treeBounds = null;
      
      // skill1MaxY 계산 (데이터 로드 시 한 번만 계산)
      this.getSkill1MaxY();
      
      // 시각화 업데이트
      this.updateVisuals();
      this.centerTree();
      
    } catch (error) {
      console.error('스킬 데이터 로드 중 오류 발생:', error);
      this.showNotification('스킬 데이터를 불러오는데 실패했습니다.', 'error');
    }
  }

  setupJobSelector(jobList) {
    const container = document.getElementById('jobSelectorContainer');
    if (!container) return;

    const select = document.createElement('select');
    select.id = 'jobSelector';
    select.className = 'job-selector';

    jobList
      .sort((a, b) => parseInt(a.id) - parseInt(b.id))  // ID 기준으로 정렬
      .forEach(job => {
        const option = document.createElement('option');
        option.value = job.id;
        option.textContent = job.name;
        option.selected = job.id === this.jobId;
        select.appendChild(option);
      });

    select.addEventListener('change', (event) => {
      this.jobId = event.target.value;
      this.updateStatsDisplay();
    });

    container.innerHTML = '';
    container.appendChild(select);
  }

  async initializeSimulator() {
    try {
      this.showLoadingIndicator();  // 로딩 인디케이터 표시
      
      // 데이터 로드 및 초기 설정
      await this.loadSkillData();  // 스킬 데이터 로드 대기
      
      // SVG 요소들 미리 생성
      this.defs.selectAll('*').remove();  // defs 초기화
      
      // 유니크한 이미지 파일 목록 추출 및 심볼 미리 생성
      const uniqueImages = [...new Set(this.nodes.map(node => node.imageUrl))];
      const symbols = this.defs.selectAll('symbol')
        .data(uniqueImages, d => d)
        .join('symbol')
        .attr('id', d => `symbol-${d.split('/').pop().replace('.', '-')}`);

      symbols.selectAll('image')
        .data(d => [d])
        .join('image')
        .attr('href', d => d);

      // 클리핑 패스 미리 생성
      const clipPaths = this.defs.selectAll('clipPath')
        .data(this.nodes.flatMap(node => {
          if (node.type === 'node') {
            if (node.id === '101001' || node.id === '201001') {
              return [{
                id: `clip-${node.id}`,
                x: node.imageClip.x,
                y: node.imageClip.y,
                width: node.imageClip.width,
                height: node.imageClip.height
              }];
            }
            return [
              {
                id: `clip-inactive-${node.id}`,
                x: node.imageClip.x,
                y: node.imageClip.y,
                width: node.imageClip.width,
                height: node.imageClip.height
              },
              {
                id: `clip-active-${node.id}`,
                x: node.activeClip.x,
                y: node.activeClip.y,
                width: node.activeClip.width,
                height: node.activeClip.height
              }
            ];
          }
          return [{
            id: `clip-${node.id}`,
            x: node.imageClip.x,
            y: node.imageClip.y,
            width: node.imageClip.width,
            height: node.imageClip.height
          }];
        }), d => d.id)
        .join('clipPath')
        .attr('id', d => d.id);

      clipPaths.selectAll('rect')
        .data(d => [d])
        .join('rect')
        .attr('x', d => d.x)
        .attr('y', d => d.y)
        .attr('width', d => d.width)
        .attr('height', d => d.height);

      // URL에서 상태 로드
      this.loadFromURL();
      
      // 트리 경계값 미리 계산
      this._treeBounds = this.calculateTreeBounds();
      
      // 모든 준비가 끝난 후에 시각화 시작
      await new Promise(resolve => {
        requestAnimationFrame(() => {
          this.drawNodes();  // 노드 그리기
          this.updatePointsDisplay();  // 포인트 표시 업데이트
          this.centerTree();  // 트리 중앙 정렬
          resolve();
        });
      });

    } catch (error) {
      console.error('초기화 중 오류 발생:', error);
      this.showNotification('스킬 트리를 초기화하는데 실패했습니다.', 'error');
    } finally {
      this.hideLoadingIndicator();  // 로딩 완료 후 인디케이터 숨김
    }
  }

  calculateTreeBounds() {
    if (this.nodes.length === 0) return null;

    const tree1Nodes = this.nodes.filter(n => n.skillSet === 'skill1');
    const tree2Nodes = this.nodes.filter(n => n.skillSet === 'skill2');
    const skill1MaxY = this.getSkill1MaxY();

    const bounds1 = {
      minX: Math.min(...tree1Nodes.map(n => n.x || 0)),
      maxX: Math.max(...tree1Nodes.map(n => n.x + (n.width || n.imageClip.width) || 0)),
      minY: Math.min(...tree1Nodes.map(n => n.y || 0)),
      maxY: Math.max(...tree1Nodes.map(n => n.y + (n.height || n.imageClip.height) || 0))
    };

    const bounds2 = {
      minX: Math.min(...tree2Nodes.map(n => n.x || 0)),
      maxX: Math.max(...tree2Nodes.map(n => n.x + (n.width || n.imageClip.width) || 0)),
      minY: Math.min(...tree2Nodes.map(n => n.y || 0)),
      maxY: Math.max(...tree2Nodes.map(n => n.y + (n.height || n.imageClip.height) || 0))
    };

    return {
      minX: Math.min(bounds1.minX, bounds2.minX),
      maxX: Math.max(bounds1.maxX, bounds2.maxX),
      minY: bounds1.minY,
      maxY: bounds2.maxY + skill1MaxY
    };
  }

  // 로딩 인디케이터 표시
  showLoadingIndicator() {
    this.loadingIndicator.style.display = 'flex';
  }

  // 로딩 인디케이터 숨김
  hideLoadingIndicator() {
    this.loadingIndicator.style.display = 'none';
  }

  updateSvgSize() {
    const width = window.innerWidth;
    const height = window.innerHeight;
    
    this.svg
      .attr("width", width)
      .attr("height", height)
      .attr("viewBox", "0 0 1920 1080")
      .attr("preserveAspectRatio", "xMidYMid meet");
    
    if (!this.isInitialized) {
      requestAnimationFrame(() => {
        this.centerTree();
        this.isInitialized = true;
      });
    }
  }

  centerTree() {
    // 노드가 없는 경우 처리
    if (this.nodes.length === 0) {
      return;
    }

    // 캐시된 경계값이 있고 유효하면 사용
    if (this._treeBounds && 
        !isNaN(this._treeBounds.minX) && 
        !isNaN(this._treeBounds.maxX) && 
        !isNaN(this._treeBounds.minY) && 
        !isNaN(this._treeBounds.maxY)) {
      const bounds = this._treeBounds;
      this.applyTreeTransform(bounds);
      return;
    }

    // 캐시된 값이 없거나 유효하지 않으면 새로 계산
    // 트리1과 트리2의 노드 분리
    const tree1Nodes = this.nodes.filter(n => n.skillSet === 'skill1');
    const tree2Nodes = this.nodes.filter(n => n.skillSet === 'skill2');

    // 캐시된 skill1MaxY 사용
    const skill1MaxY = this.getSkill1MaxY();

    // 트리1의 범위 계산
    const bounds1 = {
      minX: Math.min(...tree1Nodes.map(n => n.x || 0)),
      maxX: Math.max(...tree1Nodes.map(n => n.x + (n.width || n.imageClip.width) || 0)),
      minY: Math.min(...tree1Nodes.map(n => n.y || 0)),
      maxY: Math.max(...tree1Nodes.map(n => n.y + (n.height || n.imageClip.height) || 0))
    };

    // 트리2의 범위 계산
    const bounds2 = {
      minX: Math.min(...tree2Nodes.map(n => n.x || 0)),
      maxX: Math.max(...tree2Nodes.map(n => n.x + (n.width || n.imageClip.width) || 0)),
      minY: Math.min(...tree2Nodes.map(n => n.y || 0)),
      maxY: Math.max(...tree2Nodes.map(n => n.y + (n.height || n.imageClip.height) || 0))
    };

    // 전체 범위 계산
    const bounds = {
      minX: Math.min(bounds1.minX, bounds2.minX),
      maxX: Math.max(bounds1.maxX, bounds2.maxX),
      minY: bounds1.minY,
      maxY: bounds2.maxY + skill1MaxY  // 트리2의 실제 화면 위치 고려
    };
    
    // bounds가 유효하지 않은 경우 처리
    if (isNaN(bounds.minX) || isNaN(bounds.maxX) || isNaN(bounds.minY) || isNaN(bounds.maxY)) {
      console.warn('Invalid bounds detected');
      return;
    }

    // 계산된 경계값 캐싱
    this._treeBounds = bounds;
    
    // 변환 적용
    this.applyTreeTransform(bounds);
  }

  applyTreeTransform(bounds) {
    const width = 1920;  // 고정된 viewBox 크기 사용
    const height = 1080;
    
    const treeWidth = bounds.maxX - bounds.minX + 100;
    const treeHeight = bounds.maxY - bounds.minY + 100;
    
    // 0으로 나누는 것을 방지
    if (treeWidth === 0 || treeHeight === 0) {
      console.warn('Invalid tree dimensions');
      return;
    }
    
    const scaleX = width / treeWidth;
    const scaleY = height / treeHeight;
    const scale = Math.min(scaleX, scaleY, 1);
    
    const centerX = (bounds.maxX + bounds.minX) / 2;
    const centerY = (bounds.maxY + bounds.minY) / 2;
    
    const transform = d3.zoomIdentity
      .translate(width / 2, height / 2)
      .scale(scale)
      .translate(-centerX, -centerY);
    
    this.svg
      .transition()
      .duration(750)
      .call(this.zoom.transform, transform);
  }

  handleZoom(event) {
    this.container.attr('transform', event.transform);
  }

  drawNodes() {
    // 배경, 연결선, 스킬 노드 필터링
    const backgroundNodes = this.nodes.filter(node => node.type === 'background');
    const lineNodes = this.nodes.filter(node => node.type === 'line');
    const skillNodes = this.nodes.filter(node => node.type === 'node');

    // 캐시된 skill1MaxY 사용
    const skill1MaxY = this.getSkill1MaxY();

    // 활성화된 노드들의 라인 ID 수집
    const activeLineIds = new Set();
    const potentialLineIds = new Set();
    
    skillNodes.forEach(node => {
      if (node.active) {
        // 활성화된 노드의 연결선 처리
        node.connectedLines?.forEach(lineId => {
          // 연결된 다른 노드 찾기
          const connectedNode = skillNodes.find(n => 
            n.id !== node.id && n.connectedLines?.includes(lineId)
          );
          
          if (connectedNode) {
            if (connectedNode.active) {
              // 양쪽 다 활성화된 경우
              activeLineIds.add(lineId);
            } else if (this.canActivateNode(connectedNode)) {
              // 한쪽만 활성화되고 다른 쪽이 활성화 가능한 경우
              potentialLineIds.add(lineId);
            }
          }
        });
      }
    });

    // 모든 라인 노드에 상태 정보 추가
    const adjustedLineNodes = lineNodes.map(line => ({
      ...line,
      displayY: line.skillSet === 'skill2' ? line.y + skill1MaxY : line.y,
      lineState: activeLineIds.has(line.id) ? 'active' : 
                 potentialLineIds.has(line.id) ? 'potential' : 'hidden'
    }));

    // 모든 노드의 y좌표 조정
    const adjustBackgroundNodes = backgroundNodes.map(node => ({
      ...node,
      displayY: node.skillSet === 'skill2' ? node.y + skill1MaxY : node.y
    }));

    const adjustedSkillNodes = skillNodes.map(node => ({
      ...node,
      displayY: node.skillSet === 'skill2' ? node.y + skill1MaxY : node.y,
      tooltip: node.tooltip  // 기존 툴팁 정보 유지
    }));

    // 모든 노드 합치기 (배경 -> 라인 -> 스킬 순서로 정렬)
    const allNodes = [...adjustBackgroundNodes, ...adjustedLineNodes, ...adjustedSkillNodes];

    // defs 요소 확인 및 생성
    let defs = this.svg.select('defs');
    if (defs.empty()) {
      defs = this.svg.append('defs');
    }

    // 유니크한 이미지 파일 목록 추출
    const uniqueImages = [...new Set(allNodes.map(node => node.imageUrl))];

    // 이미지별로 하나의 심볼 생성
    const symbols = defs.selectAll('symbol')
      .data(uniqueImages, d => d)
      .join('symbol')
      .attr('id', d => `symbol-${d.split('/').pop().replace('.', '-')}`);

    // 심볼 내부에 이미지 추가
    symbols.selectAll('image')
      .data(d => [d])
      .join('image')
      .attr('href', d => d);

    // 클리핑 패스 생성
    const clipPaths = defs.selectAll('clipPath')
      .data(allNodes.flatMap(node => {
        if (node.type === 'node') {
          // 시작 노드는 하나의 클리핑 패스만 사용
          if (node.id === '101001' || node.id === '201001') {
            return [{
              id: `clip-${node.id}`,
              x: node.imageClip.x,
              y: node.imageClip.y,
              width: node.imageClip.width,
              height: node.imageClip.height
            }];
          }
          // 일반 노드는 inactive/active 클리핑 패스 두 개 생성
          return [
            {
              id: `clip-inactive-${node.id}`,
              x: node.imageClip.x,
              y: node.imageClip.y,
              width: node.imageClip.width,
              height: node.imageClip.height
            },
            {
              id: `clip-active-${node.id}`,
              x: node.activeClip.x,
              y: node.activeClip.y,
              width: node.activeClip.width,
              height: node.activeClip.height
            }
          ];
        }
        // 배경이나 라인은 하나의 클리핑 패스만 사용
        return [{
          id: `clip-${node.id}`,
          x: node.imageClip.x,
          y: node.imageClip.y,
          width: node.imageClip.width,
          height: node.imageClip.height
        }];
      }), d => d.id)
      .join('clipPath')
      .attr('id', d => d.id);

    clipPaths.selectAll('rect')
      .data(d => [d])
      .join('rect')
      .attr('x', d => d.x)
      .attr('y', d => d.y)
      .attr('width', d => d.width)
      .attr('height', d => d.height);

    // 요소 업데이트
    const elements = this.container.selectAll('.element')
      .data(allNodes, d => d.id);
    
    elements.exit().remove();
    
    // 기존 요소의 업데이트
    elements
      .attr('class', d => `element ${d.type} ${d.skillSet}${d.active ? ' active' : ''}`)
      .attr('transform', d => `translate(${d.x}, ${d.displayY})`);

    // 기존 요소의 use 요소 업데이트
    elements.each(function(d) {
      const element = d3.select(this);
      if (d.type === 'line') {
        element.selectAll('use')
          .style('opacity', () => {
            switch (d.lineState) {
              case 'active': return 1;
              case 'potential': return 0.5;
              default: return 0;
            }
          });
      } else if (d.type === 'node') {
        element.select('use')
          .attr('clip-path', d => {
            // 시작 노드는 단일 클리핑 패스 사용
            if (d.id === '101001' || d.id === '201001') {
              return `url(#clip-${d.id})`;
            }
            // 일반 노드는 상태에 따라 다른 클리핑 패스 사용
            return `url(#clip-${d.active ? 'active' : 'inactive'}-${d.id})`;
          })
          .attr('x', d => {
            // 시작 노드는 항상 imageClip 좌표 사용
            if (d.id === '101001' || d.id === '201001') {
              return -d.imageClip.x;
            }
            return d.active ? -d.activeClip.x : -d.imageClip.x;
          })
          .attr('y', d => {
            // 시작 노드는 항상 imageClip 좌표 사용
            if (d.id === '101001' || d.id === '201001') {
              return -d.imageClip.y;
            }
            return d.active ? -d.activeClip.y : -d.imageClip.y;
          });
      }
    });

    // 새로운 요소 생성
    const elementEnter = elements.enter()
      .append('g')
      .attr('class', d => `element ${d.type} ${d.skillSet}${d.active ? ' active' : ''}`)
      .attr('transform', d => `translate(${d.x}, ${d.displayY})`)
      .attr('data-id', d => d.id)  // ID를 데이터 속성으로 추가
      .on('mousedown', (event, d) => {
        if (event.button === 2) {  // 우클릭
          this.isRightDragging = true;
          event.preventDefault();

          // 노드인 경우에만 토글 처리
          if (d.type === 'node') {
            const originalNode = this.nodes.find(n => n.id === d.id);
            if (originalNode.active) {
              // 이미 활성화된 노드는 직접 비활성화 가능한지 확인
              if (this.canDeactivateNode(originalNode)) {
                this.deactivateNode(originalNode);
                // UI 업데이트
                d.active = originalNode.active;
                const element = d3.select(event.currentTarget);
                element.classed('active', d.active);
                this.updateNodeVisuals(originalNode);
                this.updatePointsDisplay();
                this.saveToURL();
              }
            } else if (this.canActivateNode(originalNode)) {
              // 비활성화된 노드는 활성화 가능한지 확인
              this.activateNode(originalNode);
              // UI 업데이트
              d.active = originalNode.active;
              const element = d3.select(event.currentTarget);
              element.classed('active', d.active);
              this.updateNodeVisuals(originalNode);
              this.updatePointsDisplay();
              this.saveToURL();
            }
          }
        }
      })
      .on('mouseover', (event, d) => {
        if (d.type === 'node') {
          this.showTooltip(event, d);
          d3.select(event.currentTarget).style('cursor', 'pointer');
          
          // 우클릭 드래그 중이면 노드 토글 (자동 활성화/비활성화 없이)
          if (this.isRightDragging) {
            const originalNode = this.nodes.find(n => n.id === d.id);
            if (originalNode.active) {
              // 이미 활성화된 노드는 직접 비활성화 가능한지 확인
              if (this.canDeactivateNode(originalNode)) {
                this.deactivateNode(originalNode);
                // UI 업데이트
                d.active = originalNode.active;
                const element = d3.select(event.currentTarget);
                element.classed('active', d.active);
                this.updateNodeVisuals(originalNode);
                this.updatePointsDisplay();
                this.saveToURL();
              }
            } else if (this.canActivateNode(originalNode)) {
              // 비활성화된 노드는 활성화 가능한지 확인
              this.activateNode(originalNode);
              // UI 업데이트
              d.active = originalNode.active;
              const element = d3.select(event.currentTarget);
              element.classed('active', d.active);
              this.updateNodeVisuals(originalNode);
              this.updatePointsDisplay();
              this.saveToURL();
            }
          }
        }
      })
      .on('mousemove', (event, d) => {
        if (d.type === 'node') {
          this.showTooltip(event, d);
        }
      })
      .on('mouseout', (event) => {
        this.hideTooltip();
        d3.select(event.currentTarget).style('cursor', 'default');
      })
      .on('click', (event, d) => {
        if (d.type === 'node') {
          const element = d3.select(event.currentTarget);
          // 원본 노드 객체 찾기
          const originalNode = this.nodes.find(n => n.id === d.id);
          const success = this.toggleNode(originalNode);
          if (success) {
            // UI 업데이트
            d.active = originalNode.active;  // 복사본의 상태도 업데이트
            element.classed('active', d.active);
            element.select('use')
              .attr('clip-path', d => {
                // 시작 노드는 단일 클리핑 패스 사용
                if (d.id === '101001' || d.id === '201001') {
                  return `url(#clip-${d.id})`;
                }
                // 일반 노드는 상태에 따라 다른 클리핑 패스 사용
                return `url(#clip-${d.active ? 'active' : 'inactive'}-${d.id})`;
              })
              .attr('x', d => {
                // 시작 노드는 항상 imageClip 좌표 사용
                if (d.id === '101001' || d.id === '201001') {
                  return -d.imageClip.x;
                }
                return d.active ? -d.activeClip.x : -d.imageClip.x;
              })
              .attr('y', d => {
                if (d.id === '101001' || d.id === '201001') {
                  return -d.imageClip.y;
                }
                return d.active ? -d.activeClip.y : -d.imageClip.y;
              });
          }
        }
      });

    // use 요소 생성
    elementEnter.each(function(d) {
      const element = d3.select(this);
      if (d.type === 'line') {
        const isHorizontal = d.width / d.imageClip.width > d.height / d.imageClip.height;
        const count = isHorizontal ? Math.ceil((d.width - 1) / d.imageClip.width) : Math.ceil((d.height - 1) / d.imageClip.height);
        for (let i = 0; i < count; i++) {
          element.append('use')
            .attr('href', d => `#symbol-${d.imageUrl.split('/').pop().replace('.', '-')}`)
            .attr('clip-path', d => `url(#clip-${d.id})`)
            .attr('x', d => isHorizontal ? i * d.imageClip.width - d.imageClip.x : -d.imageClip.x)
            .attr('y', d => isHorizontal ? -d.imageClip.y : i * d.imageClip.height - d.imageClip.y)
            .style('transition', 'opacity 0.5s ease')  // 투명도 변경 애니메이션 추가
            .style('opacity', d => {
              switch (d.lineState) {
                case 'active': return 1;
                case 'potential': return 0.5;
                default: return 0;
              }
            });
        }
      } else {
        element.append('use')
          .attr('href', d => `#symbol-${d.imageUrl.split('/').pop().replace('.', '-')}`)
          .attr('clip-path', d => {
            // 시작 노드는 단일 클리핑 패스 사용
            if (d.id === '101001' || d.id === '201001') {
              return `url(#clip-${d.id})`;
            }
            // 백그라운드와 라인은 단일 클리핑 패스 사용
            if (d.type === 'background' || d.type === 'line') {
              return `url(#clip-${d.id})`;
            }
            // 일반 노드는 상태에 따라 다른 클리핑 패스 사용
            return `url(#clip-${d.active ? 'active' : 'inactive'}-${d.id})`;
          })
          .attr('x', d => {
            // 시작 노드는 항상 imageClip 좌표 사용
            if (d.id === '101001' || d.id === '201001') {
              return -d.imageClip.x;
            }
            // 백그라운드와 라인은 항상 imageClip 좌표 사용
            if (d.type === 'background' || d.type === 'line') {
              return -d.imageClip.x;
            }
            return d.active ? -d.activeClip.x : -d.imageClip.x;
          })
          .attr('y', d => {
            // 시작 노드는 항상 imageClip 좌표 사용
            if (d.id === '101001' || d.id === '201001') {
              return -d.imageClip.y;
            }
            // 백그라운드와 라인은 항상 imageClip 좌표 사용
            if (d.type === 'background' || d.type === 'line') {
              return -d.imageClip.y;
            }
            return d.active ? -d.activeClip.y : -d.imageClip.y;
          });
      }
    });

    // 디버깅을 위한 경계 표시
    if (0) {
      elementEnter.append('rect')
        .attr('class', 'debug-border')
        .attr('x', 0)
        .attr('y', 0)
        .attr('width', d => d.width)
        .attr('height', d => d.height)
        .style('fill', 'none')
        .style('stroke', 'red')
        .style('stroke-width', '1px')
        .style('pointer-events', 'none');
    }
  }

  showTooltip(event, node) {
    const tooltip = d3.select('#tooltip');
    let name, description;

    if (node.tooltip?.size > 0) {
      const tooltipText = node.tooltip.get(this.jobId) || node.tooltip.values().next().value;
      if (!tooltipText) {
        name = node.name;
        description = '';
      } else {
        const lines = tooltipText.split('\n\n');
        name = lines[0];
        description = lines.slice(1).join('\n\n');
      }
    } else {
      name = node.name;
      description = '';
    }
    
    tooltip.html(`
      <strong>${name}</strong>
      <div style="white-space: pre-wrap;">${description}</div>
      <div class="cost">소모 포인트: ${node.cost}</div>
    `);
    
    const tooltipElement = tooltip.node();
    const mouseX = event.pageX;
    const mouseY = event.pageY;
    const tooltipWidth = tooltipElement.offsetWidth;
    const tooltipHeight = tooltipElement.offsetHeight;
    const windowWidth = window.innerWidth;
    const windowHeight = window.innerHeight;
    
    let left = mouseX + 10;
    let top = mouseY + 10;
    
    if (left + tooltipWidth > windowWidth) {
      left = mouseX - tooltipWidth - 10;
    }
    
    if (top + tooltipHeight > windowHeight) {
      top = mouseY - tooltipHeight - 10;
    }
    
    tooltip
      .style('left', `${left}px`)
      .style('top', `${top}px`)
      .style('display', 'block');
  }

  hideTooltip() {
    d3.select('#tooltip').style('display', 'none');
  }

  findNodesToDeactivate(targetNode) {
    // 시작 노드는 비활성화 불가
    if (targetNode.id === '101001' || targetNode.id === '201001') return null;

    // 이 노드에 의존하는 활성화된 노드들 찾기
    const dependentNodes = Array.from(this.nodeMap.values()).filter(n => 
      n.active && 
      n.id !== targetNode.id && 
      n.required.includes(targetNode.id)
    );

    if (dependentNodes.length === 0) return [];  // 의존하는 노드가 없으면 바로 비활성화 가능

    // 각 의존 노드별로 대체 경로가 있는지 확인
    const nodesToDeactivate = new Set();
    nodesToDeactivate.add(targetNode.id);

    const startNodeId = targetNode.id.startsWith('1') ? '101001' : '201001';
    
    // 의존하는 노드들 중 대체 경로가 없는 노드들을 찾아서 비활성화 목록에 추가
    dependentNodes.forEach(depNode => {
      // 시작 노드는 건너뛰기
      if (depNode.id === '101001' || depNode.id === '201001') return;

      // 현재 노드와 비활성화할 노드들을 제외하고 시작 노드에서 이 노드로 가는 경로가 있는지 확인
      const hasAlternatePath = this.hasPathToStart(depNode, startNodeId, nodesToDeactivate);
      if (!hasAlternatePath) {
        // 대체 경로가 없으면 이 노드도 비활성화해야 함
        nodesToDeactivate.add(depNode.id);
        // 이 노드에 의존하는 다른 노드들도 재귀적으로 확인
        this.findDependentNodesToDeactivate(depNode, nodesToDeactivate, startNodeId);
      }
    });

    return Array.from(nodesToDeactivate);
  }

  findDependentNodesToDeactivate(node, nodesToDeactivate, startNodeId) {
    // 인접 리스트를 사용하여 의존하는 노드들 찾기
    for (const neighborId of this.adjList.get(node.id)) {
      const neighborNode = this.nodeMap.get(neighborId);
      // 시작 노드는 건너뛰기
      if (neighborNode && 
          neighborNode.id !== '101001' && 
          neighborNode.id !== '201001' && 
          neighborNode.active && 
          !nodesToDeactivate.has(neighborId) && 
          neighborNode.required.includes(node.id)) {
        const hasAlternatePath = this.hasPathToStart(neighborNode, startNodeId, nodesToDeactivate);
        if (!hasAlternatePath) {
          nodesToDeactivate.add(neighborId);
          this.findDependentNodesToDeactivate(neighborNode, nodesToDeactivate, startNodeId);
        }
      }
    }
  }

  hasPathToStart(node, startNodeId, excludedNodes) {
    const visited = new Set(excludedNodes);
    const queue = [node.id];
    visited.add(node.id);

    while (queue.length > 0) {
      const currentId = queue.shift();
      const currentNode = this.nodeMap.get(currentId);

      if (!currentNode || !currentNode.active) continue;

      if (currentNode.required.includes(startNodeId)) {
        return true;  // 시작 노드로 가는 경로 발견
      }

      // 인접 리스트를 사용하여 연결된 노드들 탐색
      for (const neighborId of this.adjList.get(currentId)) {
        const neighborNode = this.nodeMap.get(neighborId);
        if (neighborNode && 
            neighborNode.active && 
            !visited.has(neighborId) && 
            currentNode.required.includes(neighborId)) {
          queue.push(neighborId);
          visited.add(neighborId);
        }
      }
    }
    
    return false;  // 경로를 찾지 못함
  }

  toggleNode(node) {
    const actualNode = this.nodeMap.get(node.id);
    if (!actualNode) return false;

    // 현재 상태 저장
    this.saveState();

    if (actualNode.active) {  // 비활성화 시도
      if (this.canDeactivateNode(actualNode)) {
        this.deactivateNode(actualNode);
        this.deactivateAndCleanup(actualNode);
        this.updateNodeVisuals(actualNode);
        this.updatePointsDisplay();
        this.saveToURL();
        return true;
      } else {
        // 비활성화가 불가능한 경우, 필요한 노드들을 찾아서 함께 비활성화
        const nodesToDeactivate = this.findNodesToDeactivate(actualNode);
        if (nodesToDeactivate === null) {
          this.showNotification('이 노드는 비활성화할 수 없습니다.', 'warning');
          return false;
        }

        // 찾은 노드들을 모두 비활성화
        nodesToDeactivate.forEach(nodeId => {
          const node = this.nodeMap.get(nodeId);
          if (node) {
            this.deactivateNode(node);
          }
        });

        // 전체 시각화 업데이트
        this.updateVisuals();
        this.saveToURL();
        return true;
      }
    } else {  // 활성화 시도
      if (this.canActivateNode(actualNode)) {
        this.activateNode(actualNode);
        this.updateNodeVisuals(actualNode);
        this.updatePointsDisplay();
        this.saveToURL();
        return true;
      } else {
        // 포인트가 부족한 경우
        const points = actualNode.id.startsWith('1') ? this.firstAwakenPoints : this.secondAwakenPoints;
        if (points.used + actualNode.cost > points.total) {
          this.showNotification('스킬 포인트가 부족합니다.', 'warning');
          return false;
        }

        // 선행 스킬이 없는 경우 최단 경로 찾기 시도
        const path = this.findShortestPathToActiveNode(actualNode);
        if (path) {
          // 경로상의 모든 노드 활성화 가능한지 확인 (포인트 체크)
          const totalCost = path.reduce((sum, nodeId) => {
            const node = this.nodeMap.get(nodeId);
            return sum + (node?.cost || 0);
          }, 0);

          if (points.used + totalCost - 1 > points.total) {
            this.showNotification('최단 경로의 스킬을 활성화할 포인트가 부족합니다.', 'warning');
            return false;
          }

          // 경로상의 모든 노드 활성화
          path.forEach(nodeId => {
            const pathNode = this.nodeMap.get(nodeId);
            if (pathNode && !pathNode.active) {
              this.activateNode(pathNode);
              this.updateNodeVisuals(pathNode);
            }
          });

          // 전체 노드 다시 그리기
          this.drawNodes();
          this.updatePointsDisplay();
          this.saveToURL();
          // this.showNotification('필요한 선행 스킬들이 자동으로 활성화되었습니다.', 'info');
          return true;
        } else {
          this.showNotification('활성화할 수 있는 경로를 찾을 수 없습니다.', 'warning');
          return false;
        }
      }
    }
  }

  findShortestPathToActiveNode(targetNode) {
    // 시작 노드 ID
    const startNodeId = targetNode.id.startsWith('1') ? '101001' : '201001';
    
    // BFS를 위한 큐
    const queue = [];
    // 방문한 노드 추적
    const visited = new Set();
    // 경로 추적을 위한 맵
    const parent = new Map();
    
    // 시작점에서 역방향으로 BFS 시작
    queue.push(targetNode.id);
    visited.add(targetNode.id);
    
    while (queue.length > 0) {
      const currentId = queue.shift();
      const currentNode = this.nodeMap.get(currentId);
      
      // 현재 노드가 존재하지 않으면 건너뛰기
      if (!currentNode) continue;
      
      // 현재 노드가 활성화되어 있거나 시작 노드인 경우
      if (currentNode.active || currentId === startNodeId) {
        // 경로 재구성
        const path = [];
        let nodeId = currentId;
        while (nodeId !== targetNode.id) {
          path.unshift(nodeId);
          nodeId = parent.get(nodeId);
        }
        path.push(targetNode.id);
        
        // 시작 노드는 이미 활성화되어 있으므로 제외
        if (path[0] === startNodeId) {
          path.shift();
        }
        
        return path;
      }
      
      // 인접 리스트를 사용하여 연결된 노드들 탐색
      for (const neighborId of this.adjList.get(currentId)) {
        if (!visited.has(neighborId)) {
          const neighborNode = this.nodeMap.get(neighborId);
          // required 관계 확인
          if (neighborNode && currentNode.required.includes(neighborId)) {
            queue.push(neighborId);
            visited.add(neighborId);
            parent.set(neighborId, currentId);
          }
        }
      }
    }
    
    return null;  // 경로를 찾지 못한 경우
  }

  updateNodeVisuals(node) {
    // 캐시된 skill1MaxY 사용
    const skill1MaxY = this.getSkill1MaxY();
    const displayY = node.skillSet === 'skill2' ? node.y + skill1MaxY : node.y;

    // 해당 노드의 요소만 업데이트
    const element = this.container.select(`.element[data-id="${node.id}"]`);
    if (!element.empty()) {
      element
        .attr('class', `element ${node.type} ${node.skillSet}${node.active ? ' active' : ''}`)
        .attr('transform', `translate(${node.x}, ${displayY})`);

      element.select('use')
        .attr('clip-path', d => {
          // 시작 노드는 단일 클리핑 패스 사용
          if (d.id === '101001' || d.id === '201001') {
            return `url(#clip-${d.id})`;
          }
          // 일반 노드는 상태에 따라 다른 클리핑 패스 사용
          return `url(#clip-${d.active ? 'active' : 'inactive'}-${d.id})`;
        })
        .attr('x', d => {
          // 시작 노드는 항상 imageClip 좌표 사용
          if (d.id === '101001' || d.id === '201001') {
            return -d.imageClip.x;
          }
          return d.active ? -d.activeClip.x : -d.imageClip.x;
        })
        .attr('y', d => {
          // 시작 노드는 항상 imageClip 좌표 사용
          if (d.id === '101001' || d.id === '201001') {
            return -d.imageClip.y;
          }
          return d.active ? -d.activeClip.y : -d.imageClip.y;
        });
    }

    // 연결된 라인들의 상태 업데이트
    this.updateConnectedLines(node);
  }

  updateConnectedLines(node) {
    if (!node.connectedLines) return;

    node.connectedLines.forEach(lineId => {
      const lineData = this.linesMap.get(lineId);
      if (!lineData) return;

      // 자기 자신이 아닌 쪽이 connectedNode
      const connectedNodeId = lineData.nodeIds.find(id => id !== node.id);
      const connectedNode = this.nodeMap.get(connectedNodeId);

      if (connectedNode) {
        let lineState = 'hidden';
        if (node.active && connectedNode.active) {
          lineState = 'active';
        } else if ((node.active && this.canActivateNode(connectedNode)) || 
                   (connectedNode.active && this.canActivateNode(node))) {
          lineState = 'potential';
        }

        // 라인 요소 업데이트
        const lineElement = this.container.selectAll('.element.line')
          .filter(d => d.id === lineId);

        if (!lineElement.empty()) {
          lineElement
            .classed('potential', lineState === 'potential')
            .selectAll('use')
            .style('transition', 'opacity 0.5s ease')  // 투명도 변경 애니메이션 추가
            .style('opacity', () => {
              switch (lineState) {
                case 'active': return 1;
                case 'potential': return 0.5;
                default: return 0;
              }
            });
        }
      }
    });
  }

  getSkill1MaxY() {
    if (this._skill1MaxY === null) {
      const skill1Nodes = this.nodes.filter(node => 
        node.type === 'background' && node.skillSet === 'skill1'
      );
      this._skill1MaxY = Math.max(...skill1Nodes.map(node => 
        node.y + node.imageClip.height
      ));
    }
    return this._skill1MaxY;
  }

  deactivateAndCleanup(node) {
    const deactivatedNodes = new Set();
    deactivatedNodes.add(node.id);
    
    const affectedNodes = this.cleanupDisconnectedNodes(deactivatedNodes);
    
    // 영향받은 노드들만 시각적으로 업데이트
    affectedNodes.forEach(nodeId => {
      const node = this.nodes.find(n => n.id === nodeId);
      if (node) {
        this.updateNodeVisuals(node);
      }
    });
    
    this.updatePointsDisplay();
  }

  cleanupDisconnectedNodes(deactivatedNodes) {
    const startNodes = ['101001', '201001'];
    const affectedNodes = new Set(deactivatedNodes);
    
    const activeNodes = Array.from(this.nodeMap.values()).filter(
      n => n.active && !deactivatedNodes.has(n.id) && n.type === 'node'
    );

    const connectedNodes = new Set();
    startNodes.forEach(sid => connectedNodes.add(sid));

    let changed;
    do {
      changed = false;
      activeNodes.forEach(node => {
        if (!connectedNodes.has(node.id)) {
          const isConnected = node.required.some(reqId => {
            if (deactivatedNodes.has(reqId)) return false;
            return connectedNodes.has(reqId);
          });
          if (isConnected) {
            connectedNodes.add(node.id);
            changed = true;
          }
        }
      });
    } while (changed);

    activeNodes.forEach(node => {
      if (!connectedNodes.has(node.id)) {
        this.deactivateNode(node);
        deactivatedNodes.add(node.id);
        affectedNodes.add(node.id);
      }
    });

    return affectedNodes;
  }

  canActivateNode(node) {
    // 시작 노드는 항상 활성화 가능
    if (node.id === '101001' || node.id === '201001') return true;
    
    // 필요한 포인트 확인
    const points = node.id.startsWith('1') ? this.firstAwakenPoints : this.secondAwakenPoints;
    if (points.used + node.cost > points.total) return false;
    
    // 선행 노드 확인
    return node.required.some(reqId => {
      const requiredNode = this.nodeMap.get(reqId);
      return requiredNode && requiredNode.active;
    });
  }

  canDeactivateNode(node) {
    // 시작 노드는 비활성화 불가
    if (node.id === '101001' || node.id === '201001') return false;
    
    // 이 노드에 의존하는 활성화된 노드들 찾기
    const dependentNodes = Array.from(this.nodeMap.values()).filter(n => 
      n.active && // 활성화된 노드만 체크
      n.id !== node.id && // 자기 자신 제외
      n.required.includes(node.id) // 현재 노드를 필요로 하는 노드
    );

    if (dependentNodes.length === 0) return true;  // 의존하는 노드가 없으면 비활성화 가능

    // 의존하는 노드들이 다른 경로로 시작 노드와 연결되어 있는지 확인
    const startNodeId = node.id.startsWith('1') ? '101001' : '201001';
    const connectedNodes = new Set();
    connectedNodes.add(startNodeId);

    // 현재 노드를 제외하고 연결된 노드들 찾기
    let changed;
    do {
      changed = false;
      for (const n of this.nodeMap.values()) {
        if (n.active && n.id !== node.id && !connectedNodes.has(n.id)) {
          const isConnected = n.required.some(reqId => 
            reqId !== node.id && connectedNodes.has(reqId)
          );
          if (isConnected) {
            connectedNodes.add(n.id);
            changed = true;
          }
        }
      }
    } while (changed);

    // 모든 의존 노드가 다른 경로로 연결되어 있는지 확인
    return dependentNodes.every(n => connectedNodes.has(n.id));
  }

  activateNode(node) {
    const prevPoints = node.id.startsWith('1') ? this.firstAwakenPoints.used : this.secondAwakenPoints.used;
    node.active = true;  // 상태 변경
    const points = node.id.startsWith('1') ? this.firstAwakenPoints : this.secondAwakenPoints;
    points.used += node.cost;
    
    // 포인트가 0이 되거나 0에서 변경되는 경우 모든 연결선 업데이트
    if (points.used === points.total || prevPoints === points.total) {
      this.updateAllConnectedLines();
    }
    this.updateStatsDisplay();
  }

  deactivateNode(node) {
    const prevPoints = node.id.startsWith('1') ? this.firstAwakenPoints.used : this.secondAwakenPoints.used;
    node.active = false;  // 상태 변경
    const points = node.id.startsWith('1') ? this.firstAwakenPoints : this.secondAwakenPoints;
    points.used -= node.cost;
    
    // 포인트가 0이 되거나 0에서 변경되는 경우 모든 연결선 업데이트
    if (points.used === points.total || prevPoints === points.total) {
      this.updateAllConnectedLines();
    }
    this.updateStatsDisplay();
  }

  updateAllConnectedLines() {
    // 모든 노드의 연결선 상태 업데이트
    const skillNodes = this.nodes.filter(node => node.type === 'node');
    const activeLineIds = new Set();
    const potentialLineIds = new Set();
    
    skillNodes.forEach(node => {
      if (node.active && node.connectedLines) {
        node.connectedLines.forEach(lineId => {
          const connectedNode = skillNodes.find(n => 
            n.id !== node.id && n.connectedLines?.includes(lineId)
          );
          
          if (connectedNode) {
            if (connectedNode.active) {
              activeLineIds.add(lineId);
            } else if (this.canActivateNode(connectedNode)) {
              potentialLineIds.add(lineId);
            }
          }
        });
      }
    });

    // 모든 라인 요소 업데이트
    this.container.selectAll('.element.line').each((d) => {
      const lineElement = this.container.selectAll('.element.line')
        .filter(line => line.id === d.id);

      if (!lineElement.empty()) {
        let lineState = 'hidden';
        if (activeLineIds.has(d.id)) {
          lineState = 'active';
        } else if (potentialLineIds.has(d.id)) {
          lineState = 'potential';
        }

        lineElement
          .classed('potential', lineState === 'potential')
          .selectAll('use')
          .style('transition', 'opacity 0.5s ease')
          .style('opacity', () => {
            switch (lineState) {
              case 'active': return 1;
              case 'potential': return 0.5;
              default: return 0;
            }
          });
      }
    });
  }

  updateVisuals() {
    this.drawNodes();
    this.updatePointsDisplay();
  }

  updatePointsDisplay() {
    const firstAwakenElement = d3.select('#firstAwakenPoints');
    const secondAwakenElement = d3.select('#secondAwakenPoints');
    
    firstAwakenElement.html(`
      <div class="points-title">1차 각성</div>
      <div class="points-value">${this.firstAwakenPoints.total - this.firstAwakenPoints.used}</div>
      <div class="points-total">/ ${this.firstAwakenPoints.total}</div>
    `);
    
    secondAwakenElement.html(`
      <div class="points-title">2차 각성</div>
      <div class="points-value">${this.secondAwakenPoints.total - this.secondAwakenPoints.used}</div>
      <div class="points-total">/ ${this.secondAwakenPoints.total}</div>
    `);

    // 능력치 정보 업데이트
    this.updateStatsDisplay();
  }

  updateStatsDisplay() {
    const stats = this.collectStats();
    this.statsContent.innerHTML = '';

    if (this.currentTab === 'all') {
      // 전체 탭일 경우 1차와 2차 능력치 합산
      const combinedStats = {
        basic: new Map(),
        special: new Set()
      };

      // 기본 능력치 합산
      for (const [type, value] of stats.first.basic) {
        combinedStats.basic.set(type, value);
      }
      for (const [type, value] of stats.second.basic) {
        const currentValue = combinedStats.basic.get(type) || 0;
        combinedStats.basic.set(type, currentValue + value);
      }

      // 특수 효과 합치기
      for (const effect of stats.first.special) {
        combinedStats.special.add(effect);
      }
      for (const effect of stats.second.special) {
        combinedStats.special.add(effect);
      }

      this.renderStatsSection('전체 능력치', combinedStats);
    } else if (this.currentTab === 'first') {
      this.renderStatsSection('1차 각성 능력치', stats.first);
    } else if (this.currentTab === 'second') {
      this.renderStatsSection('2차 각성 능력치', stats.second);
    }
  }

  collectStats() {
    const stats = {
      first: {
        basic: new Map(),
        special: new Set()
      },
      second: {
        basic: new Map(),
        special: new Set()
      }
    };

    // 노드 순회하면서 능력치 수집
    for (const node of this.nodes) {
      if (!node.active || !node.tooltip?.size) continue;

      const category = node.id.startsWith('1') ? stats.first : stats.second;
      const tooltipText = node.tooltip.get(this.jobId) || node.tooltip.values().next().value;
      if (!tooltipText) continue;

      const lines = tooltipText.split('\n');
      const remainingLines = lines.slice(1).filter(line => !line.trim().startsWith('☞'));  // 첫 행(Name) 제외 및 특수 효과 제외

      // 일반 능력치 패턴 매칭 (/ 기호가 포함된 경우도 처리)
      const statPattern = /([가-힣A-Za-z\s\/\<\>]+)\s*([+-]\s*\d+\.?\d*)(%)?/g;
      let match;

      // 첫 행을 제외한 나머지 라인들에 대해서만 능력치 매칭
      for (const line of remainingLines) {
        while ((match = statPattern.exec(line)) !== null) {
          const [, type, value, unit] = match;
          const trimmedType = type.trim();
          
          // 스킬 레벨 처리
          if (trimmedType.endsWith('스킬 레벨')) {
            const skillNameMatch = trimmedType.match(/\<(.+?)\>/);  // <스킬명> 패턴 매칭
            if (skillNameMatch) {
              const skillName = skillNameMatch[1];  // < > 안의 내용만 추출
              const statKey = `${skillName} 스킬 레벨`;
              const currentValue = category.basic.get(statKey) || 0;
              const numericValue = parseFloat(value.replace(/\s+/g, ''));
              category.basic.set(statKey, (currentValue * 10 + numericValue * 10) / 10);
            }
          } else {
            const statKey = unit ? `${trimmedType}%` : trimmedType;  // % 단위 처리 수정
            const currentValue = category.basic.get(statKey) || 0;
            const numericValue = parseFloat(value.replace(/\s+/g, ''));  // 공백 제거 후 변환
            // 소수점이 있는 값을 그대로 유지
            category.basic.set(statKey, (currentValue * 10 + numericValue * 10) / 10);  // 부동소수점 오차 방지
          }
        }
      }

      // 특수 효과 패턴 매칭
      for (const line of remainingLines) {
        if (line.includes('특수 효과')) {
          const name = lines[0].trim();  // 첫 행의 스킬 이름 사용
          category.special.add(name);
          break;
        }
      }
    }

    return stats;
  }

  renderStatsSection(title, stats) {
    const section = document.createElement('div');
    section.className = 'stats-section';
    section.style.userSelect = 'text';  // 텍스트 선택 가능하도록 설정
    section.innerHTML = `<h3>${title}</h3>`;

    const list = document.createElement('ul');
    list.style.userSelect = 'text';  // 리스트도 선택 가능하도록 설정

    // 기본 능력치를 배열로 변환하고 정렬
    const sortedStats = Array.from(stats.basic.entries()).sort((a, b) => {
      // 스킬 레벨이 있는 경우 최상단에 표시
      if (a[0].includes('스킬 레벨') && !b[0].includes('스킬 레벨')) return -1;
      if (!a[0].includes('스킬 레벨') && b[0].includes('스킬 레벨')) return 1;
      
      // 먼저 이름순으로 정렬
      const aName = a[0].replace('%', '');  // % 제거하고 비교
      const bName = b[0].replace('%', '');
      const nameCompare = aName.localeCompare(bName);
      if (nameCompare !== 0) return nameCompare;
      
      // 이름이 같은 경우 % 단위가 있는 것을 위로
      const aHasPercent = a[0].endsWith('%');
      const bHasPercent = b[0].endsWith('%');
      if (aHasPercent && !bHasPercent) return -1;
      if (!aHasPercent && bHasPercent) return 1;
      
      return 0;
    });

    // 정렬된 능력치 표시
    for (const [typeWithUnit, value] of sortedStats) {
      const li = document.createElement('li');
      // % 단위가 있는 경우와 없는 경우를 구분하여 처리
      if (typeWithUnit.endsWith('%')) {
        const type = typeWithUnit.slice(0, -1);  // % 제거
        const sign = value >= 0 ? '+' : '';  // 음수는 이미 - 기호가 있으므로 + 기호만 처리
        li.textContent = `${type} ${sign}${value.toString()}%`;
      } else {
        const sign = value >= 0 ? '+' : '';  // 음수는 이미 - 기호가 있으므로 + 기호만 처리
        li.textContent = `${typeWithUnit} ${sign}${value.toString()}`;
      }
      list.appendChild(li);
    }

    // 특수 효과 표시
    if (stats.special.size > 0) {
      const specialLi = document.createElement('li');
      specialLi.style.marginTop = '10px';
      specialLi.style.color = '#4a9eff';
      specialLi.textContent = '특수 효과';
      list.appendChild(specialLi);

      // 특수 효과도 정렬하여 표시
      const sortedEffects = Array.from(stats.special).sort();
      for (const effect of sortedEffects) {
        const li = document.createElement('li');
        li.style.paddingLeft = '15px';
        li.style.color = '#aaa';
        li.textContent = effect;
        list.appendChild(li);
      }
    }

    section.appendChild(list);
    this.statsContent.appendChild(section);
  }

  setupEventListeners() {
    // 초기화 버튼
    document.getElementById('resetButton').addEventListener('click', () => {
      if (confirm('정말 초기화하시겠습니까?')) {
        this.resetSkillTree();
      }
    });

    // 실행 취소/되돌리기 단축키
    document.addEventListener('keydown', (event) => {
      // Ctrl+Z: 실행 취소
      if (event.ctrlKey && !event.shiftKey && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        this.undo();
      }
      // Ctrl+Y 또는 Ctrl+Shift+Z: 되돌리기
      else if ((event.ctrlKey && event.key.toLowerCase() === 'y') ||
               (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'z')) {
        event.preventDefault();
        this.redo();
      }
    });

    // 능력치 탭 전환
    const statsTabs = document.querySelectorAll('#statsContainer .tab');
    statsTabs.forEach(tab => {
      tab.addEventListener('click', (event) => {
        statsTabs.forEach(t => t.classList.remove('active'));
        event.currentTarget.classList.add('active');
        this.currentTab = tab.dataset.tab;
        this.updateStatsDisplay();
      });
    });
  }

  resetSkillTree() {
    // 현재 상태 저장
    this.saveState();

    this.nodes.forEach(node => {
      if (node.id === '101001' || node.id === '201001') {
        node.active = true;
      } else {
        node.active = false;
      }
    });
    
    this.firstAwakenPoints.used = 0;
    this.secondAwakenPoints.used = 0;
    
    // 트리 초기화 시 경계값 캐시만 초기화 (skill1MaxY는 유지)
    this._treeBounds = null;
    
    this.updateVisuals();
    this.saveToURL();
    this.showNotification('스킬 트리가 초기화되었습니다.', 'info');
  }

  handleHashChange() {
    // 내부적인 변경이면 무시
    if (this.isInternalHashChange) {
      this.isInternalHashChange = false;
      return;
    }
    
    // 외부에서의 URL 변경인 경우 상태 로드
    this.loadFromURL();
  }

  saveToURL() {
    // 노드만 필터링
    const nodesList = this.nodes
      .filter(node => node.type === 'node');

    // 비트 배열 생성 (8비트 단위)
    const bits = new Uint8Array(Math.ceil(nodesList.length / 8));
    
    nodesList.forEach((node, index) => {
      if (node.active) {
        const byteIndex = Math.floor(index / 8);
        const bitIndex = index % 8;
        bits[byteIndex] |= (1 << bitIndex);
      }
    });

    // Base64로 변환
    const hash = btoa(String.fromCharCode.apply(null, bits))
      .replace(/\+/g, '-')  // URL 안전한 문자로 대체
      .replace(/\//g, '_')
      .replace(/=+$/, '');   // 패딩 제거

    // 현재 해시와 동일하면 업데이트하지 않음
    if (window.location.hash === '#' + hash) {
      return;
    }

    // 내부 변경 플래그 설정
    this.isInternalHashChange = true;

    // replaceState를 사용하여 히스토리 항목 생성 없이 URL 업데이트
    const newURL = window.location.pathname + '#' + hash;
    window.history.replaceState(null, '', newURL);
  }

  loadFromURL() {
    const hash = window.location.hash.slice(1);
    
    // 노드만 필터링
    const nodesList = this.nodes
      .filter(node => node.type === 'node');

    // 시작 노드는 항상 활성화
    this.nodes.forEach(node => {
      node.active = node.id === '101001' || node.id === '201001';
    });

    if (!hash) {
      this.updateVisuals();
      return;
    }

    try {
      // Base64 디코딩
      const normalizedHash = hash
        .replace(/-/g, '+')  // URL 안전 문자를 원래 Base64 문자로 복원
        .replace(/_/g, '/');
      
      // 패딩 추가
      const padding = normalizedHash.length % 4;
      const paddedHash = padding ? 
        normalizedHash + '='.repeat(4 - padding) : 
        normalizedHash;
      
      // 비트 배열로 변환
      const bits = new Uint8Array(
        atob(paddedHash)
          .split('')
          .map(char => char.charCodeAt(0))
      );

      // 노드 상태 복원
      nodesList.forEach((node, index) => {
        if (node.id === '101001' || node.id === '201001') return;  // 시작 노드는 건너뜀
        
        const byteIndex = Math.floor(index / 8);
        const bitIndex = index % 8;
        
        if (byteIndex < bits.length) {
          node.active = (bits[byteIndex] & (1 << bitIndex)) !== 0;
        }
      });

      // 포인트 재계산
      this.firstAwakenPoints.used = 0;
      this.secondAwakenPoints.used = 0;
      
      this.nodes.forEach(node => {
        if (node.active && node.type === 'node' && node.id !== '101001' && node.id !== '201001') {
          const points = node.id.startsWith('1') ? this.firstAwakenPoints : this.secondAwakenPoints;
          points.used += node.cost;
        }
      });

      // 시각화 업데이트
      this.drawNodes();
      this.updatePointsDisplay();
      
    } catch (error) {
      console.error('URL 해시 디코딩 중 오류 발생:', error);
      this.showNotification('잘못된 URL 형식입니다.', 'error');
      this.resetSkillTree();
    }
  }

  showNotification(message, type = 'info') {
    const container = document.getElementById('notificationContainer');
    const notification = document.createElement('div');
    notification.className = `notification ${type}`;
    notification.style.pointerEvents = 'none';  // 마우스 이벤트를 뒤로 전달
    
    let icon;
    switch (type) {
      case 'success':
        icon = 'check-circle';
        break;
      case 'error':
        icon = 'times-circle';
        break;
      case 'warning':
        icon = 'exclamation-triangle';
        break;
      default:
        icon = 'info-circle';
    }
    
    notification.innerHTML = `
      <i class="fas fa-${icon}"></i>
      <span>${message}</span>
    `;
    
    // 컨테이너도 pointer-events: none 설정
    container.style.pointerEvents = 'none';
    
    container.appendChild(notification);
    
    setTimeout(() => {
      notification.remove();
      // 컨테이너에 더 이상 알림이 없으면 pointer-events 제거
      if (container.children.length === 0) {
        container.style.pointerEvents = '';
      }
    }, 5000);
  }

  createNodeData(node) {
    // 공통 데이터
    const nodeData = {
      id: node.INSTANCEID,
      name: node.PARENT || '',
      x: parseInt(node.COOP_X) || 0,
      y: parseInt(node.COOP_Y) || 0,
      width: parseInt(node.OBJECT_SIZE_X) || 0,
      height: parseInt(node.OBJECT_SIZE_Y) || 0,
      imageUrl: `assets/${node.IMAGE_FILENAME}`,
      imageClip: {
        x: parseInt(node.IMAGE_X) || 0,
        y: parseInt(node.IMAGE_Y) || 0,
        width: parseInt(node.IMAGE_X2) - parseInt(node.IMAGE_X) || 0,
        height: parseInt(node.IMAGE_Y2) - parseInt(node.IMAGE_Y) || 0
      },
      activeClip: {
        x: parseInt(node.ACTIVE_X) || 0,
        y: parseInt(node.ACTIVE_Y) || 0,
        width: parseInt(node.ACTIVE_X2) - parseInt(node.ACTIVE_X) || 0,
        height: parseInt(node.ACTIVE_Y2) - parseInt(node.ACTIVE_Y) || 0
      }
    };

    // 타입별 추가 데이터
    if (node.PARENT?.startsWith('Awaken_Skill_BG') || node.PARENT?.startsWith('Awaken_Skill2_BG')) {
      nodeData.type = 'background';
      nodeData.skillSet = node.INSTANCEID.startsWith('1') ? 'skill1' : 'skill2';
    } else if (node.PARENT?.startsWith('Awaken_Skill_Line') || node.PARENT?.startsWith('Awaken_Skill2_Line')) {
      nodeData.type = 'line';
      nodeData.skillSet = node.INSTANCEID.startsWith('1') ? 'skill1' : 'skill2';
      nodeData.connectedLines = [];
    } else {
      nodeData.type = 'node';
      nodeData.skillSet = node.INSTANCEID.startsWith('1') ? 'skill1' : 'skill2';
      nodeData.cost = node.id === '101001' || node.id === '201001' ? 0 : 1;
      nodeData.active = node.id === '101001' || node.id === '201001';
      nodeData.required = [];
      nodeData.connectedLines = node.LINE_INSTANCE || [];
      
      // REQUIRE_SLOT이 문자열인 경우 배열로 변환
      if (typeof node.REQUIRE_SLOT === 'string' && node.REQUIRE_SLOT) {
        nodeData.required = [node.REQUIRE_SLOT];
      } else if (Array.isArray(node.REQUIRE_SLOT)) {
        nodeData.required = node.REQUIRE_SLOT;
      }
      
      // 툴팁 정보를 Map으로 저장
      nodeData.tooltip = new Map();
      Object.entries(node).forEach(([key, value]) => {
        if (!isNaN(key) && value) {  // key가 숫자이고 value가 존재하는 경우
          nodeData.tooltip.set(key, value);
        }
      });
    }

    return nodeData;
  }

  // 현재 상태를 저장
  saveState() {
    const state = {
      nodes: this.nodes.map(node => ({
        id: node.id,
        active: node.active
      })),
      firstAwakenPoints: { ...this.firstAwakenPoints },
      secondAwakenPoints: { ...this.secondAwakenPoints }
    };

    this.undoStack.push(state);
    this.redoStack = [];  // 새로운 상태가 저장되면 redo 스택 초기화

    // 스택 크기 제한
    if (this.undoStack.length > this.maxStackSize) {
      this.undoStack.shift();
    }
  }

  // 상태 복원
  restoreState(state) {
    // 노드 상태 복원
    state.nodes.forEach(savedNode => {
      const node = this.nodeMap.get(savedNode.id);
      if (node) {
        node.active = savedNode.active;
      }
    });

    // 포인트 상태 복원
    this.firstAwakenPoints = { ...state.firstAwakenPoints };
    this.secondAwakenPoints = { ...state.secondAwakenPoints };

    // 시각화 업데이트
    this.updateVisuals();
    this.saveToURL();
  }

  // 실행 취소
  undo() {
    if (this.undoStack.length === 0) return;

    // 현재 상태를 redo 스택에 저장
    const currentState = {
      nodes: this.nodes.map(node => ({
        id: node.id,
        active: node.active
      })),
      firstAwakenPoints: { ...this.firstAwakenPoints },
      secondAwakenPoints: { ...this.secondAwakenPoints }
    };
    this.redoStack.push(currentState);

    // 이전 상태 복원
    const previousState = this.undoStack.pop();
    this.restoreState(previousState);
  }

  // 되돌리기
  redo() {
    if (this.redoStack.length === 0) return;

    // 현재 상태를 undo 스택에 저장
    const currentState = {
      nodes: this.nodes.map(node => ({
        id: node.id,
        active: node.active
      })),
      firstAwakenPoints: { ...this.firstAwakenPoints },
      secondAwakenPoints: { ...this.secondAwakenPoints }
    };
    this.undoStack.push(currentState);

    // 다음 상태 복원
    const nextState = this.redoStack.pop();
    this.restoreState(nextState);
  }

  setupStatsDisplay() {
    // DOM 요소들이 존재하는지 확인
    this.statsContainer = document.getElementById('statsContainer');
    this.toggleStatsButton = document.getElementById('toggleStats');
    this.statsWrapper = document.querySelector('.stats-wrapper');
    this.statsContent = document.querySelector('.stats-content');
    this.tabs = document.querySelectorAll('.tab');

    if (!this.statsContainer || !this.toggleStatsButton || !this.statsWrapper || !this.statsContent) {
      console.error('Stats display elements not found');
      return;
    }

    // 토글 버튼 초기 상태 설정
    this.toggleStatsButton.innerHTML = `
      <i class="fas fa-chevron-down"></i>
      적용 능력치
    `;

    // 토글 이벤트 리스너
    this.toggleStatsButton.addEventListener('click', () => {
      if (this.statsContainer) {
        this.statsContainer.classList.toggle('expanded');
        const isExpanded = this.statsContainer.classList.contains('expanded');
          
        this.toggleStatsButton.innerHTML = `
          <i class="fas fa-${isExpanded ? 'chevron-up' : 'chevron-down'}"></i>
          적용 능력치
        `;
        
        if (isExpanded) {
          this.updateStatsDisplay();
        }
      }
    });

    // 탭 이벤트 리스너
    if (this.tabs) {
      this.tabs.forEach(tab => {
        tab.addEventListener('click', (event) => {
          this.tabs.forEach(t => t.classList.remove('active'));
          event.currentTarget.classList.add('active');
          this.currentTab = event.currentTarget.dataset.tab;
          this.updateStatsDisplay();
        });
      });
    }

    // 초기 상태 설정
    this.currentTab = 'all';
    this.updateStatsDisplay();
  }
}

// 인스턴스 생성
window.addEventListener('DOMContentLoaded', () => {
  window.skillTreeSimulator = new SkillTreeSimulator();
});
