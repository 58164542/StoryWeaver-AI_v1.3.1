import json
import base64
import os
import time
import subprocess
import logging
import sys
from typing import Iterator, Optional
import csv
import pandas as pd
import zipfile
import shutil
import importlib
import pkg_resources

import requests
import gradio as gr

# 配置日志
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
)
logger = logging.getLogger(__name__)

# 配置文件路径
CONFIG_FILE = "config.json"

# 加载配置
def load_config():
    logger.info(f"正在加载配置文件: {CONFIG_FILE}")
    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE, 'r', encoding='utf-8') as f:
                config = json.load(f)
                logger.info(f"成功加载配置: {config}")
                return config
        except Exception as e:
            logger.error(f"加载配置文件失败: {e}")
            return {"group_id": "", "api_key": ""}
    else:
        logger.info("配置文件不存在，使用默认空配置")
        return {"group_id": "", "api_key": ""}

# 保存配置
def save_config(group_id: str, api_key: str):
    try:
        config = {"group_id": group_id, "api_key": api_key}
        with open(CONFIG_FILE, 'w', encoding='utf-8') as f:
            json.dump(config, f, ensure_ascii=False, indent=2)
        logger.info(f"配置已保存到: {CONFIG_FILE}")
    except Exception as e:
        logger.error(f"保存配置文件失败: {e}")

# 加载初始配置
config = load_config()
group_id = config['group_id']
api_key = config['api_key']

# 配置信息
API_URL = "https://api.minimax.chat/v1/t2a_v2?GroupId="

# 支持的模型
MODELS = [
    "speech-01-hd",
    "speech-01-turbo",
    "speech-02-hd-preview",
    "speech-02-turbo-preview",
    "speech-01-240228",
    "speech-01-turbo-240228",
    "speech-2.5-hd-preview",
    "speech-2.6-hd"  # 新增speech-2.6-hd模型
]

# 支持的声音ID
VOICE_IDS = [
    "male-qn-qingse",
    "female-shaonv",
    "female-yujie",
    "male-yifeng",
    "fangqi_minimax",
    "weixue_minimax",
    "yingxiao_minimax",
    "jianmo_minimax",
    "zhuzixiao_minimax",
    "zhiqi_minimax",
    "zhouxing_minimax",
    "genghong_minimax",
    "Chinese (Mandarin)_BashfulGirl",
    "Chinese (Mandarin)_ExplorativeGirl",
    "Chinese (Mandarin)_IntellectualGirl",
    "Chinese (Mandarin)_Laid_BackGirl",
    "Chinese (Mandarin)_Pure-hearted_Boy",
    "Chinese (Mandarin)_Sincere_Adult",
    "Chinese (Mandarin)_Stubborn_Friend",
    "qinjue_minimax",
    "linmiaomiao_minimax",
    "linmiaomiao2_minimax"
]

# 声音选项（用于UI显示，支持中文名称）
VOICE_CHOICES = [
    ("male-qn-qingse", "male-qn-qingse"),
    ("female-shaonv", "female-shaonv"),
    ("female-yujie", "female-yujie"),
    ("male-yifeng", "male-yifeng"),
    ("fangqi_minimax", "fangqi_minimax"),
    ("weixue_minimax", "weixue_minimax"),
    ("yingxiao_minimax", "yingxiao_minimax"),
    ("jianmo_minimax", "jianmo_minimax"),
    ("zhuzixiao_minimax", "zhuzixiao_minimax"),
    ("zhiqi_minimax", "zhiqi_minimax"),
    ("zhouxing_minimax", "zhouxing_minimax"),
    ("genghong_minimax", "genghong_minimax"),
    ("害羞少女", "Chinese (Mandarin)_BashfulGirl"),
    ("探索少女", "Chinese (Mandarin)_ExplorativeGirl"),
    ("睿智少女", "Chinese (Mandarin)_IntellectualGirl"),
    ("慵懒少女", "Chinese (Mandarin)_Laid_BackGirl"),
    ("纯真少年", "Chinese (Mandarin)_Pure-hearted_Boy"),
    ("诚恳大人", "Chinese (Mandarin)_Sincere_Adult"),
    ("倔强挚友", "Chinese (Mandarin)_Stubborn_Friend"),
    ("装逼男主", "qinjue_minimax"),
    ("哭腔女性", "linmiaomiao_minimax"),
    ("林妙妙", "linmiaomiao2_minimax")
]

# 支持的语言增强
LANGUAGE_BOOST_OPTIONS = [
    "auto", "Chinese", "Chinese,Yue", "English", "Arabic", "Russian", 
    "Spanish", "French", "Portuguese", "German", "Turkish", "Dutch", 
    "Ukrainian", "Vietnamese", "Indonesian", "Japanese", "Italian", "Korean"
]

# 情绪选项
EMOTION_OPTIONS = [
    "happy", "neutral", "sad", "angry"
]

# 音频格式
AUDIO_FORMATS = ["mp3", "pcm", "flac"]

# 检查并安装依赖
def check_and_install_dependencies():
    """检查并安装必要的依赖库"""
    required_packages = {
        'pandas': 'pandas',
        'openpyxl': 'openpyxl',  # 用于.xlsx文件
        'xlrd': 'xlrd>=2.0.1',    # 用于.xls文件
        'requests': 'requests',
        'gradio': 'gradio'
    }
    
    missing_packages = []
    
    logger.info("检查必要的依赖库...")
    for package, install_name in required_packages.items():
        try:
            importlib.import_module(package)
            logger.info(f"√ {package} 已安装")
        except ImportError:
            logger.warning(f"✗ {package} 未找到")
            missing_packages.append(install_name)
    
    if missing_packages:
        logger.info(f"需要安装的依赖: {', '.join(missing_packages)}")
        try:
            for package in missing_packages:
                logger.info(f"正在安装 {package}...")
                subprocess.check_call([sys.executable, "-m", "pip", "install", package])
                logger.info(f"{package} 安装成功!")
            
            # 重新导入pandas，因为它可能刚刚被安装
            if 'pandas' in missing_packages:
                importlib.import_module('pandas')
            
            logger.info("所有依赖已成功安装!")
            return True
        except Exception as e:
            logger.error(f"依赖安装失败: {e}")
            return False
    else:
        logger.info("所有必要的依赖已安装!")
        return True

def convert_punctuation_and_newlines(text: str) -> str:
    """将全角标点转换为半角标点，并将换行符标准化为\n"""
    # 全角半角标点映射表
    punctuation_map = {
        '，': ',', '。': '.', '：': ':', '；': ';', '？': '?', '！': '!',
        '（': '(', '）': ')', '【': '[', '】': ']', '「': '"', '」': '"',
        '"': '"', '"': '"', ''': "'", ''': "'", '、': ',', '…': '...',
        '—': '-', '～': '~', '《': '<', '》': '>', '·': '`', '￥': '$',
        '％': '%', '＋': '+', '－': '-', '＝': '=', '＊': '*', '／': '/',
        '＜': '<', '＞': '>', '＆': '&', '｜': '|', '～': '~', '＠': '@',
        '＃': '#', '＄': '$', '＾': '^', '｛': '{', '｝': '}'
    }
    
    # 转换标点
    for full, half in punctuation_map.items():
        text = text.replace(full, half)
    
    # 标准化换行符（将所有类型的换行符转换为\n）
    text = text.replace('\r\n', '\n').replace('\r', '\n')
    
    return text

def build_tts_headers(api_key: str) -> dict:
    """构建TTS请求头"""
    return {
        'accept': 'application/json, text/plain, */*',
        'content-type': 'application/json',
        'authorization': f"Bearer {api_key}",
    }

def build_tts_body(
    text: str,
    model: str,
    voice_id: str,
    speed: float,
    volume: float,
    pitch: int,
    pronunciation_dict: Optional[dict] = None,
    sample_rate: int = 32000,
    bitrate: int = 128000,
    audio_format: str = "mp3",
    channel: int = 1,
    is_stream: bool = False,
    language_boost: Optional[str] = None,
    subtitle_enable: bool = False,
    emotion: str = "happy"  # 修改默认情绪为happy
) -> str:
    """构建TTS请求体"""
    
    body = {
        "model": model,
        "text": text,
        "stream": is_stream,
        "audio_setting": {
            "sample_rate": sample_rate,
            "bitrate": bitrate,
            "format": audio_format,
            "channel": channel
        }
    }
    
    # 处理声音选择
    if voice_id in ["fangqi_minimax", "weixue_minimax", "yingxiao_minimax", "jianmo_minimax", "zhuzixiao_minimax"]:
        # 使用timber_weights配置
        body["timber_weights"] = [
            {
                "voice_id": voice_id,
                "weight": 100  # 使用100作为权重值
            }
        ]
        body["voice_setting"] = {
            "voice_id": "",  # 当使用timber_weights时，voice_id设为空
            "speed": speed,
            "vol": volume,
            "pitch": pitch,
            "emotion": emotion  # 添加情绪参数
        }
    else:
        # 使用普通voice_id配置
        body["voice_setting"] = {
            "voice_id": voice_id,
            "speed": speed,
            "vol": volume,
            "pitch": pitch
        }
    
    # 添加可选参数
    if pronunciation_dict:
        body["pronunciation_dict"] = pronunciation_dict
    
    if language_boost:
        body["language_boost"] = language_boost
    
    if subtitle_enable:
        body["subtitle_enable"] = subtitle_enable
    
    return json.dumps(body, ensure_ascii=False)

def call_tts_api(
    text: str,
    group_id: str,
    api_key: str,
    model: str,
    voice_id: str,
    speed: float,
    volume: float,
    pitch: int,
    pronunciation_dict: Optional[list] = None,
    sample_rate: int = 32000,
    bitrate: int = 128000,
    audio_format: str = "mp3",
    is_stream: bool = False,
    language_boost: Optional[str] = None,
    subtitle_enable: bool = False,
    emotion: str = "happy"  # 修改默认情绪为happy
) -> bytes:
    """调用TTS API生成音频"""
    
    url = API_URL + group_id
    headers = build_tts_headers(api_key)
    
    # 处理发音字典
    dict_obj = {}
    if pronunciation_dict and len(pronunciation_dict.strip()) > 0:
        try:
            dict_entries = [item.strip() for item in pronunciation_dict.split('\n') if item.strip()]
            dict_obj = {"tone": dict_entries}
        except Exception as e:
            logger.error(f"发音字典解析错误: {e}")
            dict_obj = {}
    
    body = build_tts_body(
        text=text,
        model=model,
        voice_id=voice_id,
        speed=speed,
        volume=volume,
        pitch=pitch,
        pronunciation_dict=dict_obj if dict_obj else None,
        sample_rate=sample_rate,
        bitrate=bitrate,
        audio_format=audio_format,
        is_stream=is_stream,
        language_boost=language_boost if language_boost != "auto" else "auto",
        subtitle_enable=subtitle_enable,
        emotion=emotion  # 传递情绪参数
    )
    
    logger.info(f"请求URL: {url}")
    logger.info(f"请求参数: {body}")
    
    # 直接使用非流式请求，避免文本重复问题
    try:
        logger.info("使用非流式请求生成音频")
        response = requests.post(url, headers=headers, data=body)
        response.raise_for_status()  # 检查HTTP错误
        
        response_json = response.json()
        logger.info(f"请求成功，状态码: {response.status_code}")
        
        if 'data' in response_json and 'audio' in response_json['data']:
            audio_hex = response_json['data']['audio']
            audio_data = bytes.fromhex(audio_hex)
            logger.info(f"成功接收音频数据，大小: {len(audio_data)} 字节")
            return audio_data
        else:
            error_msg = response_json.get('base_resp', {}).get('status_msg', '未知错误')
            logger.error(f"API返回错误: {error_msg}")
            logger.error(f"完整响应: {response_json}")
            raise Exception(f"TTS API返回错误: {error_msg}")
    except Exception as e:
        logger.error(f"API请求失败: {e}")
        raise Exception(f"API请求失败: {e}")

def save_audio(audio_data: bytes, format: str = "mp3") -> str:
    """保存音频文件并返回文件路径"""
    if not os.path.exists("output"):
        os.makedirs("output")
    
    timestamp = int(time.time())
    filename = f"output/tts_output_{timestamp}.{format}"
    
    with open(filename, "wb") as f:
        f.write(audio_data)
    
    return filename

def tts_app(
    text: str,
    model: str,
    voice_id: str,
    speed: float,
    volume: float,
    pitch: int,
    pronunciation_dict: str,
    sample_rate: int,
    bitrate: int,
    audio_format: str,
    is_stream: bool,
    language_boost: str,
    subtitle_enable: bool,
    emotion: str
):
    """TTS应用程序主函数"""
    global group_id, api_key  # 声明使用全局变量
    
    if not group_id or not api_key:
        logger.error("API密钥或Group ID未在config.json中配置")
        return None, "错误：API密钥或Group ID未配置。请编辑config.json文件。"

    try:
        logger.info("开始处理TTS请求")
        
        # 转换标点符号和换行符
        text = convert_punctuation_and_newlines(text)
        logger.info("已转换标点符号为半角，标准化换行符")
        
        logger.info(f"文本长度: {len(text)} 字符")
        logger.info(f"选择的模型: {model}")
        logger.info(f"选择的声音: {voice_id}")
        logger.info(f"选择的情绪: {emotion}")
        
        # 不再保存配置，因为无法通过UI修改
        # save_config(group_id, api_key)
        
        # 强制使用非流式请求，避免文本重复问题
        is_stream = False
        logger.info("已禁用流式处理以避免文本重复问题")
        
        audio_data = call_tts_api(
            text=text,
            group_id=group_id,  # 使用全局变量
            api_key=api_key,    # 使用全局变量
            model=model,
            voice_id=voice_id,
            speed=speed,
            volume=volume,
            pitch=pitch,
            pronunciation_dict=pronunciation_dict,
            sample_rate=sample_rate,
            bitrate=bitrate,
            audio_format=audio_format,
            is_stream=is_stream,
            language_boost=language_boost,
            subtitle_enable=subtitle_enable,
            emotion=emotion  # 传递情绪参数
        )
        
        file_path = save_audio(audio_data, audio_format)
        logger.info(f"音频文件已保存: {file_path}")
        return file_path, "转换成功！音频已保存。"
    except Exception as e:
        logger.error(f"处理失败: {str(e)}", exc_info=True)
        return None, f"错误：{str(e)}"

def create_zip_file(directory: str, zip_name: str = None) -> str:
    """将目录中的所有文件打包成zip文件"""
    if not zip_name:
        zip_name = f"batch_results_{int(time.time())}.zip"
    
    zip_path = os.path.join(directory, zip_name)
    
    try:
        with zipfile.ZipFile(zip_path, 'w') as zipf:
            for root, dirs, files in os.walk(directory):
                for file in files:
                    # 跳过日志和zip文件
                    if file.endswith('.txt') or file.endswith('.zip'):
                        continue
                    
                    file_path = os.path.join(root, file)
                    # 将文件添加到zip中，arcname参数确保只有文件名而不是完整路径
                    zipf.write(file_path, arcname=file)
        
        logger.info(f"创建ZIP文件成功: {zip_path}")
        return zip_path
    except Exception as e:
        logger.error(f"创建ZIP文件失败: {e}")
        return None

def process_batch(
    file_path: str,
    model: str,
    voice_id: str,
    speed: float,
    volume: float,
    pitch: int,
    pronunciation_dict: str,
    sample_rate: int,
    bitrate: int,
    audio_format: str,
    language_boost: str,
    subtitle_enable: bool,
    emotion: str
):
    """批量处理表格中的文本并生成音频文件"""
    global group_id, api_key
    
    if not group_id or not api_key:
        logger.error("API密钥或Group ID未在config.json中配置")
        return None, None, "错误：API密钥或Group ID未配置。请编辑config.json文件。"
    
    try:
        # 确保输出目录存在
        batch_output_dir = "output/batch"
        if not os.path.exists(batch_output_dir):
            os.makedirs(batch_output_dir)
        
        logger.info(f"开始批量处理文件: {file_path}")
        
        # 尝试使用pandas读取不同格式的表格文件
        try:
            file_ext = os.path.splitext(file_path)[1].lower()
            if file_ext == '.csv':
                df = pd.read_csv(file_path)
            elif file_ext in ['.xlsx', '.xls']:
                df = pd.read_excel(file_path)
            else:
                return None, None, f"不支持的文件格式: {file_ext}，请使用.csv, .xlsx或.xls文件"
        except Exception as e:
            logger.error(f"读取表格文件失败: {e}")
            return None, None, f"读取表格文件失败: {e}"
        
        # 检查表格格式是否符合要求（至少有ID和文本两列）
        if len(df.columns) < 2:
            return None, None, "表格格式错误：至少需要包含编号和文本两列"
        
        # 假设第一列是编号，第二列是文本
        id_column = df.columns[0]
        text_column = df.columns[1]
        
        results = []
        success_count = 0
        fail_count = 0
        
        # 创建一个唯一的批处理ID（使用时间戳）
        batch_id = int(time.time())
        batch_dir = f"{batch_output_dir}/{batch_id}"
        if not os.path.exists(batch_dir):
            os.makedirs(batch_dir)
        
        for idx, row in df.iterrows():
            item_id = str(row[id_column])
            text = str(row[text_column])
            
            if not text.strip():
                logger.warning(f"跳过空文本，编号: {item_id}")
                results.append(f"编号 {item_id}: 跳过（空文本）")
                continue
            
            try:
                logger.info(f"处理编号 {item_id}, 文本: {text[:50]}...")
                
                # 转换标点符号和换行符
                text = convert_punctuation_and_newlines(text)
                
                # 调用API生成音频
                audio_data = call_tts_api(
                    text=text,
                    group_id=group_id,
                    api_key=api_key,
                    model=model,
                    voice_id=voice_id,
                    speed=speed,
                    volume=volume,
                    pitch=pitch,
                    pronunciation_dict=pronunciation_dict,
                    sample_rate=sample_rate,
                    bitrate=bitrate,
                    audio_format=audio_format,
                    is_stream=False,  # 批量处理强制使用非流式
                    language_boost=language_boost,
                    subtitle_enable=subtitle_enable,
                    emotion=emotion
                )
                
                # 使用编号保存文件
                output_file = f"{batch_dir}/{item_id}.{audio_format}"
                with open(output_file, "wb") as f:
                    f.write(audio_data)
                
                logger.info(f"编号 {item_id} 处理成功，保存到: {output_file}")
                results.append(f"编号 {item_id}: 成功")
                success_count += 1
                
            except Exception as e:
                logger.error(f"处理编号 {item_id} 失败: {e}")
                results.append(f"编号 {item_id}: 失败 - {str(e)}")
                fail_count += 1
        
        summary = f"批量处理完成！成功: {success_count}, 失败: {fail_count}, 总计: {success_count + fail_count}"
        logger.info(summary)
        
        # 将结果写入日志文件
        log_file = f"{batch_dir}/batch_log.txt"
        with open(log_file, "w", encoding="utf-8") as f:
            f.write(f"{summary}\n\n")
            f.write("详细结果:\n")
            for result in results:
                f.write(f"{result}\n")
        
        # 创建ZIP文件供下载
        zip_file = None
        if success_count > 0:
            zip_file = create_zip_file(batch_dir, f"tts_results_{batch_id}.zip")
            if zip_file:
                logger.info(f"创建下载文件成功: {zip_file}")
            else:
                logger.error("创建下载文件失败")
        
        return batch_dir, zip_file, f"{summary}\n\n生成的音频文件保存在 {batch_dir} 目录下。"
    
    except Exception as e:
        logger.error(f"批量处理失败: {str(e)}", exc_info=True)
        return None, None, f"批量处理错误: {str(e)}"

def add_list_row(
    current_data: pd.DataFrame,
    text: str,
    model: str,
    voice: str,
    emotion: str
):
    """向UI列表添加一行"""
    # 如果是None或空，初始化DataFrame
    if current_data is None or (isinstance(current_data, list) and len(current_data) == 0):
        current_data = pd.DataFrame(columns=["ID", "Text", "Model", "Voice", "Emotion"])
    elif isinstance(current_data, list):
        current_data = pd.DataFrame(current_data, columns=["ID", "Text", "Model", "Voice", "Emotion"])
        
    # 生成ID
    try:
        if len(current_data) > 0:
            # 尝试获取最大数字ID
            max_id = 0
            for existing_id in current_data["ID"]:
                try:
                    current_num = int(existing_id)
                    if current_num > max_id:
                        max_id = current_num
                except:
                    pass
            next_id = str(max_id + 1)
        else:
            next_id = "1"
    except:
        next_id = str(len(current_data) + 1)
    
    # 创建新行
    new_row = pd.DataFrame({
        "ID": [next_id],
        "Text": [text if text else ""],
        "Model": [model],
        "Voice": [voice],
        "Emotion": [emotion]
    })
    
    # 合并
    return pd.concat([current_data, new_row], ignore_index=True)

def clear_list_data():
    """清空列表"""
    return pd.DataFrame(columns=["ID", "Text", "Model", "Voice", "Emotion"])

def delete_list_row(data: pd.DataFrame, selected_index: int):
    """删除选中行"""
    if selected_index is None or data is None or len(data) == 0:
        return data, None
        
    try:
        # 确保索引是整数
        selected_index = int(selected_index)
        if selected_index < 0 or selected_index >= len(data):
            return data, None
            
        # 删除行
        data = data.drop(selected_index).reset_index(drop=True)
        
        # 不再重新生成ID，以保持ID与预览文件的关联
        
        return data, None  # 重置选中索引
    except Exception as e:
        logger.error(f"删除行失败: {e}")
        return data, selected_index

def update_list_row(
    data: pd.DataFrame, 
    selected_index: int,
    text: str,
    model: str,
    voice: str,
    emotion: str
):
    """更新选中行"""
    if selected_index is None or data is None:
        return data, selected_index
        
    try:
        selected_index = int(selected_index)
        if selected_index < 0 or selected_index >= len(data):
            return data, selected_index
            
        # 更新数据
        data.at[selected_index, "Text"] = text
        data.at[selected_index, "Model"] = model
        data.at[selected_index, "Voice"] = voice
        data.at[selected_index, "Emotion"] = emotion
        
        return data, selected_index
    except Exception as e:
        logger.error(f"更新行失败: {e}")
        return data, selected_index

def on_select_row(data: pd.DataFrame, evt: gr.SelectData, preview_cache: dict):
    """处理行选择事件"""
    try:
        index = evt.index[0]  # 获取行索引
        row = data.iloc[index]
        item_id = str(row["ID"])
        
        # 检查是否有缓存的预览音频
        audio_path = None
        if preview_cache and item_id in preview_cache:
            audio_path = preview_cache[item_id]
            # 检查文件是否存在
            if not os.path.exists(audio_path):
                audio_path = None
        
        # 返回: 索引, 文本, 模型, 声音, 情绪, 音频文件
        return index, row["Text"], row["Model"], row["Voice"], row["Emotion"], audio_path
    except Exception as e:
        logger.error(f"选择行失败: {e}")
        return None, "", "speech-01-hd", "fangqi_minimax", "happy", None

def generate_single_row(
    data: pd.DataFrame,
    selected_index: int,
    speed: float,
    volume: float,
    pitch: int,
    pronunciation_dict: str,
    sample_rate: int,
    bitrate: int,
    audio_format: str,
    language_boost: str,
    subtitle_enable: bool,
    preview_cache: dict
):
    """生成并预览单行音频"""
    global group_id, api_key
    
    if preview_cache is None:
        preview_cache = {}
    
    if not group_id or not api_key:
        return None, "错误：API密钥或Group ID未配置。", preview_cache
        
    if selected_index is None or data is None:
        return None, "错误：请先选择一行。", preview_cache
        
    try:
        selected_index = int(selected_index)
        if selected_index < 0 or selected_index >= len(data):
            return None, "错误：无效的行选择。", preview_cache
            
        row = data.iloc[selected_index]
        item_id = str(row["ID"])
        text = str(row["Text"])
        model = str(row["Model"])
        voice_id = str(row["Voice"])
        emotion = str(row["Emotion"])
        
        if not text or not text.strip():
            return None, "错误：文本为空。", preview_cache
            
        logger.info(f"预览处理 ID {item_id}...")
        
        # 转换标点
        text = convert_punctuation_and_newlines(text)
        
        # 检查是否已存在旧的预览文件并删除
        if item_id in preview_cache:
            old_file = preview_cache[item_id]
            if old_file and os.path.exists(old_file):
                try:
                    os.remove(old_file)
                    logger.info(f"已删除旧预览文件: {old_file}")
                except Exception as e:
                    logger.warning(f"删除旧预览文件失败: {e}")
        
        # 调用API
        audio_data = call_tts_api(
            text=text,
            group_id=group_id,
            api_key=api_key,
            model=model,
            voice_id=voice_id,
            speed=speed,
            volume=volume,
            pitch=pitch,
            pronunciation_dict=pronunciation_dict,
            sample_rate=sample_rate,
            bitrate=bitrate,
            audio_format=audio_format,
            is_stream=False,
            language_boost=language_boost,
            subtitle_enable=subtitle_enable,
            emotion=emotion
        )
        
        # 保存文件
        if not os.path.exists("output/preview"):
            os.makedirs("output/preview")
            
        timestamp = int(time.time())
        output_file = f"output/preview/preview_{item_id}_{timestamp}.{audio_format}"
        with open(output_file, "wb") as f:
            f.write(audio_data)
            
        # 更新缓存
        preview_cache[item_id] = output_file
            
        return output_file, f"预览生成成功！ID: {item_id}", preview_cache
        
    except Exception as e:
        logger.error(f"预览生成失败: {e}")
        return None, f"预览失败: {str(e)}", preview_cache

def download_all_previews(preview_cache: dict):
    """打包下载所有预览文件（仅包含缓存中的文件）"""
    if not preview_cache:
        return None, "错误：暂无试听记录。"
    
    # 过滤出存在的文件
    valid_files = []
    for item_id, file_path in preview_cache.items():
        if os.path.exists(file_path):
            valid_files.append(file_path)
            
    if not valid_files:
        return None, "错误：缓存的文件已不存在。"
        
    try:
        preview_dir = "output/preview"
        if not os.path.exists(preview_dir):
            os.makedirs(preview_dir)
            
        zip_name = f"previews_{int(time.time())}.zip"
        zip_path = os.path.join(preview_dir, zip_name)
        
        with zipfile.ZipFile(zip_path, 'w') as zipf:
            for file_path in valid_files:
                # 只保留文件名
                file_name = os.path.basename(file_path)
                zipf.write(file_path, arcname=file_name)
                
        return zip_path, f"打包成功！共 {len(valid_files)} 个文件。"
    except Exception as e:
        logger.error(f"打包预览文件失败: {e}")
        return None, f"打包失败: {str(e)}"

def process_ui_list(
    data: pd.DataFrame,
    speed: float,
    volume: float,
    pitch: int,
    pronunciation_dict: str,
    sample_rate: int,
    bitrate: int,
    audio_format: str,
    language_boost: str,
    subtitle_enable: bool
):
    """处理UI列表中的数据"""
    global group_id, api_key
    
    if not group_id or not api_key:
        return None, None, "错误：API密钥或Group ID未配置。"
        
    if data is None or len(data) == 0:
        return None, None, "错误：列表为空，请先添加数据。"
        
    try:
        # 确保输出目录存在
        batch_output_dir = "output/batch"
        if not os.path.exists(batch_output_dir):
            os.makedirs(batch_output_dir)
            
        # 创建唯一的批处理ID
        batch_id = int(time.time())
        batch_dir = f"{batch_output_dir}/{batch_id}"
        if not os.path.exists(batch_dir):
            os.makedirs(batch_dir)
            
        results = []
        success_count = 0
        fail_count = 0
        
        logger.info(f"开始处理UI列表批量任务，共 {len(data)} 条")
        
        # 遍历DataFrame
        # 确保列名正确，防止用户修改列头导致错误
        # 预期列: ID, Text, Model, Voice, Emotion
        
        for index, row in data.iterrows():
            # 获取数据，处理可能的缺失或索引错误
            try:
                # 尝试通过列名获取，如果失败则按位置获取
                if "ID" in data.columns:
                    item_id = str(row["ID"])
                else:
                    item_id = str(row.iloc[0])
                    
                if "Text" in data.columns:
                    text = str(row["Text"])
                else:
                    text = str(row.iloc[1])
                    
                if "Model" in data.columns:
                    model = str(row["Model"])
                else:
                    model = str(row.iloc[2])
                    
                if "Voice" in data.columns:
                    voice_id = str(row["Voice"])
                else:
                    voice_id = str(row.iloc[3])
                    
                if "Emotion" in data.columns:
                    emotion = str(row["Emotion"])
                else:
                    emotion = str(row.iloc[4])
            except Exception as e:
                logger.error(f"解析行数据失败: {e}")
                results.append(f"行 {index+1}: 解析失败 - {e}")
                fail_count += 1
                continue
                
            if not text or not text.strip() or text.lower() == 'nan':
                logger.warning(f"跳过空文本，ID: {item_id}")
                results.append(f"ID {item_id}: 跳过（空文本）")
                continue
                
            try:
                logger.info(f"处理 ID {item_id}...")
                
                # 转换标点
                text = convert_punctuation_and_newlines(text)
                
                # 调用API
                audio_data = call_tts_api(
                    text=text,
                    group_id=group_id,
                    api_key=api_key,
                    model=model,
                    voice_id=voice_id,
                    speed=speed,
                    volume=volume,
                    pitch=pitch,
                    pronunciation_dict=pronunciation_dict,
                    sample_rate=sample_rate,
                    bitrate=bitrate,
                    audio_format=audio_format,
                    is_stream=False,
                    language_boost=language_boost,
                    subtitle_enable=subtitle_enable,
                    emotion=emotion
                )
                
                # 保存文件
                output_file = f"{batch_dir}/{item_id}.{audio_format}"
                with open(output_file, "wb") as f:
                    f.write(audio_data)
                    
                results.append(f"ID {item_id}: 成功")
                success_count += 1
                # 简单的进度反馈可以通过yield实现，但这里先用一次性返回
                
            except Exception as e:
                logger.error(f"处理 ID {item_id} 失败: {e}")
                results.append(f"ID {item_id}: 失败 - {str(e)}")
                fail_count += 1
        
        summary = f"UI列表批量处理完成！成功: {success_count}, 失败: {fail_count}"
        
        # 保存日志
        log_file = f"{batch_dir}/batch_log.txt"
        with open(log_file, "w", encoding="utf-8") as f:
            f.write(f"{summary}\n\n")
            f.write("详细结果:\n")
            for result in results:
                f.write(f"{result}\n")
                
        # 创建ZIP
        zip_file = None
        if success_count > 0:
            zip_file = create_zip_file(batch_dir, f"ui_batch_{batch_id}.zip")
            
        return batch_dir, zip_file, f"{summary}\n\n详细日志已保存。"
    
    except Exception as e:
        logger.error(f"UI列表批量处理失败: {str(e)}", exc_info=True)
        return None, None, f"处理错误: {str(e)}"

def create_ui():
    """创建Gradio用户界面"""
    with gr.Blocks(title="文本转语音(TTS)应用", theme=gr.themes.Soft()) as app:
        gr.Markdown("# 文本转语音 (TTS) 应用")
        gr.Markdown("使用MiniMax API将文本转换为自然语音")
        
        with gr.Tabs() as tabs:
            # 单文本处理标签页
            with gr.TabItem("单文本处理"):
                with gr.Row():
                    with gr.Column(scale=2):
                        # 文本输入区域
                        text_input = gr.Textbox(
                            label="要转换的文本", 
                            placeholder="输入要转换为语音的文本...", 
                            lines=5,
                            info="全角标点将自动转换为半角标点，换行将被保留"
                        )
                        
                        # 模型和声音选择
                        with gr.Row():
                            model_dropdown = gr.Dropdown(
                                choices=MODELS, 
                                label="模型", 
                                value="speech-01-hd"  # 修改默认模型
                            )
                            voice_dropdown = gr.Dropdown(
                                choices=VOICE_CHOICES, 
                                label="声音", 
                                value="fangqi_minimax"  # 修改默认声音
                            )
                        
                        # 语音参数调整
                        with gr.Row():
                            speed_slider = gr.Slider(
                                minimum=0.5, 
                                maximum=2.0, 
                                value=1.0, 
                                step=0.1, 
                                label="语速"
                            )
                            volume_slider = gr.Slider(
                                minimum=0.5, 
                                maximum=2.0, 
                                value=1.0, 
                                step=0.1, 
                                label="音量"
                            )
                            pitch_slider = gr.Slider(
                                minimum=-12, 
                                maximum=12, 
                                value=0, 
                                step=1, 
                                label="音调"
                            )
                        
                        # 高级设置折叠面板
                        with gr.Accordion("高级设置", open=False):
                            pronunciation_dict_input = gr.Textbox(
                                label="发音词典",
                                placeholder="每行一个条目，例如：处理/(chu3)(li3)",
                                lines=3
                            )
                            
                            with gr.Row():
                                sample_rate_dropdown = gr.Dropdown(
                                    choices=[16000, 24000, 32000, 44100, 48000], 
                                    label="采样率", 
                                    value=32000
                                )
                                bitrate_dropdown = gr.Dropdown(
                                    choices=[64000, 96000, 128000, 192000, 256000], 
                                    label="比特率", 
                                    value=128000
                                )
                                audio_format_dropdown = gr.Dropdown(
                                    choices=AUDIO_FORMATS, 
                                    label="音频格式", 
                                    value="mp3"
                                )
                            
                            with gr.Row():
                                stream_checkbox = gr.Checkbox(
                                    label="启用流式处理", 
                                    value=False,  # 默认禁用流式处理
                                    interactive=False,  # 设置为不可交互
                                    info="当前已禁用流式处理以避免文本重复问题"
                                )
                                subtitle_checkbox = gr.Checkbox(
                                    label="生成字幕", 
                                    value=False
                                )
                                language_boost_dropdown = gr.Dropdown(
                                    choices=LANGUAGE_BOOST_OPTIONS, 
                                    label="语言增强", 
                                    value="auto"
                                )
                            
                            with gr.Row():
                                emotion_dropdown = gr.Dropdown(
                                    choices=EMOTION_OPTIONS,
                                    label="情绪",
                                    value="happy",  # 默认为happy
                                    info="声音情绪（仅适用于fangqi_minimax、weixue_minimax、yingxiao_minimax、jianmo_minimax和zhuzixiao_minimax）"
                                )
                        
                        # 转换按钮
                        convert_btn = gr.Button("转换为语音", variant="primary")
                    
                    with gr.Column(scale=1):
                        # 输出区域
                        audio_output = gr.Audio(label="生成的语音")
                        status_output = gr.Textbox(label="状态", interactive=False)
                
                # 示例文本
                gr.Examples(
                    examples=[
                        ["真正的危险不是计算机开始像人一样思考，而是人开始像计算机一样思考。计算机只是可以帮我们处理一些简单事务。"],
                        ["人工智能是研究如何使计算机能够像人一样思考和学习的科学。"],
                        ["今天天气真好，我们一起去公园散步吧！"]
                    ],
                    inputs=text_input
                )
                
            # 批量处理标签页
            with gr.TabItem("批量处理"):
                gr.Markdown("## 批量文本转语音")
                gr.Markdown("上传一个CSV或Excel表格文件，表格中第一列为编号，第二列为文本内容。系统将批量处理并生成以编号命名的音频文件。")
                
                with gr.Row():
                    with gr.Column(scale=2):
                        # 表格文件上传
                        file_input = gr.File(
                            label="上传表格文件",
                            file_types=[".csv", ".xlsx", ".xls"],
                            type="filepath"
                        )
                        
                        # 模型和声音选择
                        with gr.Row():
                            batch_model_dropdown = gr.Dropdown(
                                choices=MODELS,
                                label="模型",
                                value="speech-01-hd"
                            )
                            batch_voice_dropdown = gr.Dropdown(
                                choices=VOICE_CHOICES,
                                label="声音",
                                value="fangqi_minimax"
                            )
                        
                        # 语音参数调整
                        with gr.Row():
                            batch_speed_slider = gr.Slider(
                                minimum=0.5,
                                maximum=2.0,
                                value=1.0,
                                step=0.1,
                                label="语速"
                            )
                            batch_volume_slider = gr.Slider(
                                minimum=0.5,
                                maximum=2.0,
                                value=1.0,
                                step=0.1,
                                label="音量"
                            )
                            batch_pitch_slider = gr.Slider(
                                minimum=-12,
                                maximum=12,
                                value=0,
                                step=1,
                                label="音调"
                            )
                        
                        # 高级设置折叠面板
                        with gr.Accordion("批量处理高级设置", open=False):
                            batch_pronunciation_dict_input = gr.Textbox(
                                label="发音词典",
                                placeholder="每行一个条目，例如：处理/(chu3)(li3)",
                                lines=3
                            )
                            
                            with gr.Row():
                                batch_sample_rate_dropdown = gr.Dropdown(
                                    choices=[16000, 24000, 32000, 44100, 48000],
                                    label="采样率",
                                    value=32000
                                )
                                batch_bitrate_dropdown = gr.Dropdown(
                                    choices=[64000, 96000, 128000, 192000, 256000],
                                    label="比特率",
                                    value=128000
                                )
                                batch_audio_format_dropdown = gr.Dropdown(
                                    choices=AUDIO_FORMATS,
                                    label="音频格式",
                                    value="mp3"
                                )
                            
                            with gr.Row():
                                batch_subtitle_checkbox = gr.Checkbox(
                                    label="生成字幕",
                                    value=False
                                )
                                batch_language_boost_dropdown = gr.Dropdown(
                                    choices=LANGUAGE_BOOST_OPTIONS,
                                    label="语言增强",
                                    value="auto"
                                )
                                batch_emotion_dropdown = gr.Dropdown(
                                    choices=EMOTION_OPTIONS,
                                    label="情绪",
                                    value="happy",
                                    info="声音情绪（仅适用于特定声音）"
                                )
                        
                        # 批量处理按钮
                        batch_process_btn = gr.Button("开始批量处理", variant="primary")
                    
                    with gr.Column(scale=1):
                        # 批量处理输出状态
                        batch_output_dir = gr.Textbox(label="输出目录", interactive=False)
                        batch_download = gr.File(label="下载所有音频文件")
                        batch_status_output = gr.Textbox(label="批量处理状态", interactive=False, lines=10)
            
            # UI列表批量处理标签页
            with gr.TabItem("列表批量处理"):
                gr.Markdown("## 列表批量文本转语音")
                gr.Markdown("在下方列表中添加行，为每一行单独设置模型、声音和文本。")
                
                with gr.Row():
                    with gr.Column(scale=2):
                        # 添加行控制区
                        with gr.Group():
                            gr.Markdown("### 任务管理（添加/编辑）")
                            # 选中行状态
                            list_selected_index = gr.State(None)
                            # 预览缓存 {row_id: file_path}
                            preview_cache = gr.State({})
                            
                            with gr.Row():
                                list_default_model = gr.Dropdown(choices=MODELS, label="模型", value="speech-01-hd")
                                list_default_voice = gr.Dropdown(choices=VOICE_CHOICES, label="声音", value="fangqi_minimax")
                                list_default_emotion = gr.Dropdown(choices=EMOTION_OPTIONS, label="情绪", value="happy")
                            
                            list_new_text = gr.Textbox(label="文本内容", placeholder="输入文本...", lines=2)
                            
                            with gr.Row():
                                list_add_btn = gr.Button("添加到列表", variant="secondary")
                                list_update_btn = gr.Button("更新选中行", variant="secondary")
                                list_delete_btn = gr.Button("删除选中行", variant="stop")
                                list_preview_btn = gr.Button("生成并试听选中行", variant="primary")
                        
                        # 试听区域
                        with gr.Row():
                            list_single_audio_output = gr.Audio(label="选中行试听", type="filepath", scale=3)
                            with gr.Column(scale=1):
                                list_download_previews_btn = gr.Button("打包下载所有试听", variant="secondary")
                                list_previews_download = gr.File(label="下载压缩包")
                                list_previews_msg = gr.Textbox(label="状态", interactive=False, lines=1)

                        # 数据列表
                        gr.Markdown("### 待处理列表 (点击行进行编辑/删除)")
                        list_data = gr.Dataframe(
                            headers=["ID", "Text", "Model", "Voice", "Emotion"],
                            datatype=["str", "str", "str", "str", "str"],
                            col_count=(5, "fixed"),
                            label="任务列表",
                            interactive=True,
                            type="pandas",
                            wrap=True
                        )
                        
                        with gr.Row():
                            list_clear_btn = gr.Button("清空列表", variant="stop")
                            list_process_btn = gr.Button("开始批量生成", variant="primary")

                            
                        # 全局音频参数
                        with gr.Accordion("全局音频参数设置", open=False):
                            with gr.Row():
                                list_speed = gr.Slider(0.5, 2.0, 1.0, 0.1, label="语速")
                                list_volume = gr.Slider(0.5, 2.0, 1.0, 0.1, label="音量")
                                list_pitch = gr.Slider(-12, 12, 0, 1, label="音调")
                            
                            list_pronunciation = gr.Textbox(label="发音词典", lines=2)
                            
                            with gr.Row():
                                list_sample_rate = gr.Dropdown([16000, 24000, 32000, 44100, 48000], label="采样率", value=32000)
                                list_bitrate = gr.Dropdown([64000, 96000, 128000, 192000, 256000], label="比特率", value=128000)
                                list_format = gr.Dropdown(AUDIO_FORMATS, label="格式", value="mp3")
                            
                            with gr.Row():
                                list_subtitle = gr.Checkbox(label="生成字幕")
                                list_lang_boost = gr.Dropdown(LANGUAGE_BOOST_OPTIONS, label="语言增强", value="auto")

                    with gr.Column(scale=1):
                        list_output_dir = gr.Textbox(label="输出目录", interactive=False)
                        list_download = gr.File(label="下载结果")
                        list_status = gr.Textbox(label="处理日志", interactive=False, lines=15)
        
        # 设置事件处理 - 单文本处理
        convert_btn.click(
            fn=tts_app,
            inputs=[
                text_input, model_dropdown, voice_dropdown, 
                speed_slider, volume_slider, pitch_slider,
                pronunciation_dict_input,
                sample_rate_dropdown, bitrate_dropdown, audio_format_dropdown,
                stream_checkbox, language_boost_dropdown, subtitle_checkbox,
                emotion_dropdown
            ],
            outputs=[audio_output, status_output]
        )
        
        # 设置事件处理 - 批量处理
        batch_process_btn.click(
            fn=process_batch,
            inputs=[
                file_input,
                batch_model_dropdown, batch_voice_dropdown,
                batch_speed_slider, batch_volume_slider, batch_pitch_slider,
                batch_pronunciation_dict_input,
                batch_sample_rate_dropdown, batch_bitrate_dropdown, batch_audio_format_dropdown,
                batch_language_boost_dropdown, batch_subtitle_checkbox,
                batch_emotion_dropdown
            ],
            outputs=[batch_output_dir, batch_download, batch_status_output]
        )
        
        # 设置事件处理 - UI列表批量处理
        list_add_btn.click(
            fn=add_list_row,
            inputs=[list_data, list_new_text, list_default_model, list_default_voice, list_default_emotion],
            outputs=[list_data]
        )
        
        # 列表选择事件
        list_data.select(
            fn=on_select_row,
            inputs=[list_data, preview_cache],
            outputs=[list_selected_index, list_new_text, list_default_model, list_default_voice, list_default_emotion, list_single_audio_output]
        )
        
        # 删除选中行
        list_delete_btn.click(
            fn=delete_list_row,
            inputs=[list_data, list_selected_index],
            outputs=[list_data, list_selected_index]
        )
        
        # 更新选中行
        list_update_btn.click(
            fn=update_list_row,
            inputs=[list_data, list_selected_index, list_new_text, list_default_model, list_default_voice, list_default_emotion],
            outputs=[list_data, list_selected_index]
        )
        
        # 生成并试听选中行
        list_preview_btn.click(
            fn=generate_single_row,
            inputs=[
                list_data, list_selected_index,
                list_speed, list_volume, list_pitch,
                list_pronunciation,
                list_sample_rate, list_bitrate, list_format,
                list_lang_boost, list_subtitle,
                preview_cache
            ],
            outputs=[list_single_audio_output, list_status, preview_cache]
        )
        
        # 下载所有预览
        list_download_previews_btn.click(
            fn=download_all_previews,
            inputs=[preview_cache],
            outputs=[list_previews_download, list_previews_msg]
        )
        
        list_clear_btn.click(fn=clear_list_data, outputs=[list_data])
        
        list_process_btn.click(
            fn=process_ui_list,
            inputs=[
                list_data,
                list_speed, list_volume, list_pitch,
                list_pronunciation,
                list_sample_rate, list_bitrate, list_format,
                list_lang_boost, list_subtitle
            ],
            outputs=[list_output_dir, list_download, list_status]
        )
        
    return app

if __name__ == "__main__":
    # 检查依赖
    if not check_and_install_dependencies():
        logger.error("无法安装必要的依赖，程序可能无法正常运行。")
        print("警告：某些依赖无法安装，请手动安装以下库：pandas, openpyxl, xlrd>=2.0.1")
        input("按Enter键继续（程序可能无法正常处理Excel文件）...")
    
    # 创建输出目录
    if not os.path.exists("output"):
        os.makedirs("output")
    
    # 启动Gradio应用
    app = create_ui()
    app.launch(
        server_name="0.0.0.0",  # 允许所有网络接口访问
        server_port=7861,       # 指定端口号
        share=False,            # 不使用gradio的公共链接
        inbrowser=True         # 自动在浏览器中打开
    ) 