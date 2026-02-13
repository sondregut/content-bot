#!/usr/bin/env python3
"""
Add owl mascot overlay to TikTok slides
Applies subtle brand watermark following design guidelines
"""

import sys
from pathlib import Path
from PIL import Image, ImageEnhance

# Owl placement configurations
OWL_CONFIGS = {
    'bottom-right': {'position': 'bottom-right', 'size_percent': 10, 'opacity': 0.18},
    'bottom-left': {'position': 'bottom-left', 'size_percent': 10, 'opacity': 0.18},
    'top-right': {'position': 'top-right', 'size_percent': 8, 'opacity': 0.15},
    'mid-right': {'position': 'mid-right', 'size_percent': 12, 'opacity': 0.20},
}

def add_owl_overlay(input_path, output_path, config='bottom-right'):
    """Add owl mascot overlay to an image"""
    
    # Load base slide
    base = Image.open(input_path).convert('RGBA')
    base_width, base_height = base.size
    
    # Load owl mascot
    script_dir = Path(__file__).parent
    owl_path = script_dir / 'owl_image_nobg.png'
    owl = Image.open(owl_path).convert('RGBA')
    
    # Get config
    cfg = OWL_CONFIGS.get(config, OWL_CONFIGS['bottom-right'])
    
    # Calculate owl size (percentage of base width)
    owl_width = int(base_width * cfg['size_percent'] / 100)
    owl_height = int(owl.height * (owl_width / owl.width))
    owl_resized = owl.resize((owl_width, owl_height), Image.Resampling.LANCZOS)
    
    # Apply opacity
    alpha = owl_resized.split()[3]
    alpha = ImageEnhance.Brightness(alpha).enhance(cfg['opacity'])
    owl_resized.putalpha(alpha)
    
    # Calculate position
    padding = int(base_width * 0.05)  # 5% padding from edges
    
    position_map = {
        'bottom-right': (base_width - owl_width - padding, base_height - owl_height - padding),
        'bottom-left': (padding, base_height - owl_height - padding),
        'top-right': (base_width - owl_width - padding, padding),
        'mid-right': (base_width - owl_width - padding, (base_height - owl_height) // 2),
    }
    
    position = position_map[cfg['position']]
    
    # Composite owl onto base
    base.paste(owl_resized, position, owl_resized)
    
    # Save as RGB (TikTok doesn't need alpha channel)
    final = base.convert('RGB')
    final.save(output_path, 'PNG', optimize=True)
    
    return output_path

def process_directory(input_dir, output_dir=None, config='bottom-right'):
    """Process all PNG files in a directory"""
    input_path = Path(input_dir)
    output_path = Path(output_dir) if output_dir else input_path.parent / f"{input_path.name}-with-owl"
    output_path.mkdir(exist_ok=True, parents=True)
    
    png_files = sorted(input_path.glob('slide_*.png'))
    
    if not png_files:
        print(f"❌ No slide_*.png files found in {input_dir}")
        return
    
    print(f"🦉 Adding owl overlay to {len(png_files)} slides...")
    print(f"   Config: {config}")
    print(f"   Input: {input_path}")
    print(f"   Output: {output_path}\n")
    
    for png_file in png_files:
        output_file = output_path / png_file.name
        add_owl_overlay(png_file, output_file, config)
        print(f"✅ {png_file.name}")
    
    print(f"\n✨ Complete! Slides saved to: {output_path}")

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print("Usage: python3 add-owl-overlay.py <input-directory> [config]")
        print("\nAvailable configs:")
        for key, cfg in OWL_CONFIGS.items():
            print(f"  {key:15} - {cfg['size_percent']}% size, {cfg['opacity']} opacity, {cfg['position']}")
        print("\nExample:")
        print("  python3 add-owl-overlay.py output-v2/psych-cost bottom-right")
        sys.exit(1)
    
    input_dir = sys.argv[1]
    config = sys.argv[2] if len(sys.argv) > 2 else 'bottom-right'
    
    process_directory(input_dir, config=config)
